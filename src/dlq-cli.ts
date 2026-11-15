/**
 * Dead-letter queue inspection and purge CLI (`src/dlq-cli.ts`).
 *
 * Gives operators a safe, offline way to list, inspect, and purge parked
 * Telegram notification entries in `DEAD_LETTER_FILE` without editing JSON by
 * hand. Never contacts Stellar or Telegram.
 *
 * Subcommands:
 *   list [--file PATH] [--json]
 *   show <id> [--file PATH] [--json]
 *   purge [--older-than <dur>] [--yes] [--file PATH] [--json]
 *
 * Safety rules:
 *   - Chat ids from the environment or embedded in entries/errors are redacted
 *     via `redactChatId` from `src/status.ts`.
 *   - Secrets are scrubbed via `safeErrorMessage` / `redactText`.
 *   - `purge` without `--yes` performs a dry run and never modifies disk.
 *   - `purge --yes` writes atomically via the queue's persistence functions.
 *   - Unknown subcommands or bad arguments print usage and exit 2.
 */

import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { pathToFileURL } from "node:url";

import {
  createDeadLetterQueue,
  DEAD_LETTER_MAX_ATTEMPTS,
  DEAD_LETTER_MAX_ENTRIES,
  DlqAccessError,
  DlqMalformedFileError,
  inspectDeadLetterFile,
  type DeadLetterEntry,
} from "./deadLetter.js";
import { redactText } from "./redact.js";
import { boundText, redactChatId } from "./status.js";

export { DlqAccessError, DlqMalformedFileError };

/**
 * Stable process exit codes returned by the dead-letter inspection CLI:
 * - `0` (`OK`): Command succeeded.
 * - `1` (`UNKNOWN_ENTRY`): Requested entry ID was not found (`show <id>`).
 * - `2` (`USAGE_ERROR`): Invalid subcommand, flag, or duration argument.
 * - `3` (`MALFORMED_FILE`): Dead-letter file contains invalid JSON, wrong schema version, or malformed entry shape.
 * - `4` (`ACCESS_FAILURE`): Filesystem read/permission/directory failure on `--file`.
 */
export const DLQ_EXIT_CODES = {
  OK: 0,
  UNKNOWN_ENTRY: 1,
  USAGE_ERROR: 2,
  MALFORMED_FILE: 3,
  ACCESS_FAILURE: 4,
} as const;

export type DlqExitCode = (typeof DLQ_EXIT_CODES)[keyof typeof DLQ_EXIT_CODES];

export const USAGE =
  "usage: npm run dlq -- <list|show <id>|purge [--older-than <dur>] [--yes]> [--file PATH] [--json]";

export class DlqUsageError extends Error {
  readonly code = "USAGE_ERROR" as const;
  readonly exitCode = DLQ_EXIT_CODES.USAGE_ERROR;

  constructor(message: string) {
    super(message.includes(USAGE) ? message : `${message}\n${USAGE}`);
    this.name = "DlqUsageError";
  }
}

export class DlqUnknownEntryError extends Error {
  readonly code = "UNKNOWN_ENTRY" as const;
  readonly exitCode = DLQ_EXIT_CODES.UNKNOWN_ENTRY;

  constructor(entryId: string) {
    super(`dead-letter entry not found: ${boundText(entryId, 120)}`);
    this.name = "DlqUnknownEntryError";
  }
}

export interface DlqEntryView extends DeadLetterEntry {
  chatId: string;
}

export interface ListDlqOptions {
  filePath: string;
  chatId?: string;
  secrets?: readonly string[];
  maxEntries?: number;
  maxAttempts?: number;
  now?: () => number;
}

export interface ShowDlqOptions extends ListDlqOptions {
  id: string;
}

export interface PurgeDlqOptions extends ListDlqOptions {
  olderThan?: string | number;
  olderThanMs?: number;
  yes?: boolean;
}

export interface PurgeDlqResult {
  dryRun: boolean;
  purged: number;
  remaining: number;
  purgedIds: string[];
  entries: DlqEntryView[];
  chatId: string;
}

const DURATION_UNITS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  sec: 1_000,
  secs: 1_000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
  w: 7 * 86_400_000,
};

/**
 * Parse a human duration (`30s`, `15m`, `2h`, `7d`, `500ms`, or compound `1h30m`)
 * into milliseconds. Throws {@link DlqUsageError} on malformed or non-positive input.
 */
export function parseDurationMs(input: string | number): number {
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input < 0) {
      throw new DlqUsageError(`invalid --older-than duration: ${String(input)}`);
    }
    return input;
  }

  const trimmed = input.trim();
  if (trimmed === "") {
    throw new DlqUsageError(`--older-than requires a duration (e.g. 30m, 24h, 7d)`);
  }

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds)) {
      throw new DlqUsageError(`invalid --older-than duration: "${input}"`);
    }
    return seconds * 1_000;
  }

  const tokenRe = /(\d+(?:\.\d+)?)\s*(ms|secs?|mins?|hrs?|days?|[smhdw])/gi;
  let totalMs = 0;
  let matchedLength = 0;
  let match: RegExpExecArray | null;

  const compact = trimmed.replace(/\s+/g, "");
  tokenRe.lastIndex = 0;
  while ((match = tokenRe.exec(compact)) !== null) {
    if (match.index !== matchedLength) {
      throw new DlqUsageError(`invalid --older-than duration: "${input}"`);
    }
    const amount = Number(match[1]);
    const unit = (match[2] ?? "").toLowerCase();
    const multiplier = DURATION_UNITS[unit];
    if (!Number.isFinite(amount) || multiplier === undefined) {
      throw new DlqUsageError(`invalid --older-than duration: "${input}"`);
    }
    totalMs += amount * multiplier;
    matchedLength = tokenRe.lastIndex;
  }

  if (matchedLength === 0 || matchedLength !== compact.length || !Number.isFinite(totalMs)) {
    throw new DlqUsageError(`invalid --older-than duration: "${input}"`);
  }

  return Math.round(totalMs);
}

/**
 * Scrub any raw chat ids or secrets from operator-facing text while preserving
 * `redactChatId`'s coarse shape for chat id mentions.
 */
export function sanitizeDlqText(
  text: string,
  knownChatIds: readonly string[] = [],
  secrets: readonly string[] = [],
): string {
  let out = text;

  for (const rawChatId of knownChatIds) {
    const trimmed = rawChatId.trim();
    if (trimmed.length >= 2 && out.includes(trimmed)) {
      out = out.split(trimmed).join(redactChatId(trimmed));
    }
  }

  // Redact explicit `chat <id>` / `chat_id=<id>` mentions with redactChatId.
  out = out.replace(
    /\b(chat(?:_id|Id)?(?:\s*[:=]|\s+))(-?\d{5,}|@[A-Za-z0-9_]{4,})/gi,
    (_full, prefix: string, id: string) => `${prefix}${redactChatId(id)}`,
  );

  // Redact negative channel/supergroup chat ids (-100...) that may appear bare.
  out = out.replace(/(?<![A-Za-z0-9_-])-100\d{6,}\b/g, (id) => redactChatId(id));

  return redactText(out, { secrets, maxLen: 4_096 });
}

function configuredChatIds(explicitChatId?: string): string[] {
  const candidates = [
    explicitChatId,
    process.env.TELEGRAM_CHAT_ID,
    process.env.TELEGRAM_MARKET_CHAT_ID,
    process.env.TELEGRAM_SQUAD_CHAT_ID,
  ];
  const ids: string[] = [];
  for (const raw of candidates) {
    if (!raw) continue;
    for (const part of raw.split(",")) {
      const trimmed = part.trim();
      if (trimmed.length > 0 && !ids.includes(trimmed)) {
        ids.push(trimmed);
      }
    }
  }
  return ids;
}

function configuredSecrets(extraSecrets?: readonly string[]): string[] {
  const secrets = [...(extraSecrets ?? [])];
  const botToken = process.env.BOT_TOKEN?.trim();
  if (botToken && botToken.length > 0 && !secrets.includes(botToken)) {
    secrets.push(botToken);
  }
  return secrets;
}

function resolveChatIdForSource(source: string, explicitChatId?: string): string {
  if (explicitChatId !== undefined) return redactChatId(explicitChatId);
  if (source === "market" && process.env.TELEGRAM_MARKET_CHAT_ID?.trim()) {
    return redactChatId(process.env.TELEGRAM_MARKET_CHAT_ID.trim());
  }
  if (source === "squad" && process.env.TELEGRAM_SQUAD_CHAT_ID?.trim()) {
    return redactChatId(process.env.TELEGRAM_SQUAD_CHAT_ID.trim());
  }
  const primary = process.env.TELEGRAM_CHAT_ID?.split(",")[0]?.trim();
  return redactChatId(primary);
}

function toEntryView(
  entry: DeadLetterEntry,
  options: { chatId?: string; secrets?: readonly string[] },
): DlqEntryView {
  const chatIds = configuredChatIds(options.chatId);
  const secrets = configuredSecrets(options.secrets);
  const rawEntry = entry as DeadLetterEntry & { chatId?: string };
  if (typeof rawEntry.chatId === "string" && rawEntry.chatId.trim().length > 0) {
    chatIds.push(rawEntry.chatId.trim());
  }
  const entryChat =
    typeof rawEntry.chatId === "string" && rawEntry.chatId.trim().length > 0
      ? redactChatId(rawEntry.chatId.trim())
      : resolveChatIdForSource(entry.source, options.chatId);

  return {
    id: sanitizeDlqText(entry.id, chatIds, secrets),
    enqueuedAt: entry.enqueuedAt,
    source: entry.source,
    ledger: entry.ledger,
    eventName: entry.eventName,
    text: sanitizeDlqText(entry.text, chatIds, secrets),
    attempts: entry.attempts,
    lastError:
      entry.lastError === null ? null : sanitizeDlqText(entry.lastError, chatIds, secrets),
    chatId: entryChat,
  };
}

function resolveMaxEntries(explicit?: number): number {
  if (explicit !== undefined) return explicit;
  return Number.isInteger(Number(process.env.DEAD_LETTER_MAX)) &&
    Number(process.env.DEAD_LETTER_MAX) >= 1
    ? Number(process.env.DEAD_LETTER_MAX)
    : DEAD_LETTER_MAX_ENTRIES;
}

/** Load and return all dead-letter entries with redacted chat ids. */
export async function listDeadLetters(options: ListDlqOptions): Promise<DlqEntryView[]> {
  const inspected = await inspectDeadLetterFile(options.filePath, {
    now: options.now,
    secrets: configuredSecrets(options.secrets),
    maxEntries: resolveMaxEntries(options.maxEntries),
  });
  return inspected.entries.map((entry) => toEntryView(entry, options));
}

/** Load and return a single dead-letter entry by id, or throw {@link DlqUnknownEntryError} if not found. */
export async function showDeadLetter(options: ShowDlqOptions): Promise<DlqEntryView> {
  const targetId = options.id.trim();
  if (!targetId) {
    throw new DlqUsageError(`show requires an entry <id>\n${USAGE}`);
  }
  const inspected = await inspectDeadLetterFile(options.filePath, {
    now: options.now,
    secrets: configuredSecrets(options.secrets),
    maxEntries: resolveMaxEntries(options.maxEntries),
  });
  const match = inspected.entries.find((entry) => entry.id === targetId);
  if (!match) {
    throw new DlqUnknownEntryError(targetId);
  }
  return toEntryView(match, options);
}

function shouldPurgeEntry(
  entry: DeadLetterEntry,
  cutoffMs: number | null,
): boolean {
  if (cutoffMs === null) return true;
  const enqueuedMs = Date.parse(entry.enqueuedAt);
  if (!Number.isFinite(enqueuedMs)) return false;
  return enqueuedMs < cutoffMs;
}

/**
 * Purge all entries (or entries older than `olderThan` / `olderThanMs`).
 *
 * Without `yes: true`, performs a dry run and leaves the file untouched.
 * With `yes: true`, atomically persists the remaining queue via `queue.flush`.
 */
export async function purgeDeadLetters(options: PurgeDlqOptions): Promise<PurgeDlqResult> {
  const now = options.now ?? Date.now;
  const ageMs =
    options.olderThanMs !== undefined
      ? parseDurationMs(options.olderThanMs)
      : options.olderThan !== undefined
        ? parseDurationMs(options.olderThan)
        : null;
  const cutoffMs = ageMs === null ? null : now() - ageMs;
  const dryRun = options.yes !== true;

  const inspected = await inspectDeadLetterFile(options.filePath, {
    now,
    secrets: configuredSecrets(options.secrets),
    maxEntries: resolveMaxEntries(options.maxEntries),
  });
  const before = inspected.entries;
  const matched = before.filter((entry) => shouldPurgeEntry(entry, cutoffMs));
  const purgedIds = matched.map((entry) => entry.id);
  const purgedSet = new Set(purgedIds);

  if (!dryRun && before.length > 0) {
    // Write purges atomically via the queue's existing persistence function:
    // `flush` resolves for entries to discard and rejects for entries to keep,
    // then persists the kept entries with write-then-rename. Since kept entries
    // have their attempt count incremented by `flush`, we load a fresh queue on
    // the same file or preserve original attempt metadata by re-enqueuing /
    // flushing through the queue's persistence pipeline.
    await persistPurgedQueue(options, before.filter((entry) => !purgedSet.has(entry.id)));
  }

  const remainingEntries = before
    .filter((entry) => !purgedSet.has(entry.id))
    .map((entry) => toEntryView(entry, options));

  return {
    dryRun,
    purged: purgedIds.length,
    remaining: remainingEntries.length,
    purgedIds,
    entries: matched.map((entry) => toEntryView(entry, options)),
    chatId: resolveChatIdForSource("default", options.chatId),
  };
}

/**
 * Atomically persist the post-purge entry set using `createDeadLetterQueue`'s
 * built-in persistence functions (`load` / `flush` / `enqueue`).
 */
async function persistPurgedQueue(
  options: ListDlqOptions,
  kept: DeadLetterEntry[],
): Promise<void> {
  // Raise maxAttempts above any existing entry's attempts+1 so `flush` keeps
  // non-purged entries in order and writes the file atomically via `persist()`.
  const highestAttempts = kept.reduce((max, e) => Math.max(max, e.attempts), 0);
  const queue = createDeadLetterQueue({
    filePath: options.filePath,
    maxEntries: Math.max(
      options.maxEntries ?? DEAD_LETTER_MAX_ENTRIES,
      kept.length + 1,
    ),
    maxAttempts: Math.max(
      options.maxAttempts ?? DEAD_LETTER_MAX_ATTEMPTS,
      highestAttempts + 2,
    ),
    secrets: configuredSecrets(options.secrets),
    now: options.now,
    quiet: true,
  });

  await queue.load();
  const current = queue.snapshot();
  if (current.length === 0) {
    return;
  }

  const keepIds = new Set(kept.map((e) => e.id));
  // Budget must cover all entries to be purged (plus 1 so the loop visits every
  // entry even when all of them are purged).
  const budget = current.length + 1;
  await queue.flush(async (_text, entry) => {
    if (keepIds.has(entry.id)) {
      throw new Error(entry.lastError ?? "retained");
    }
  }, budget);
}

interface ParsedCliArgs {
  subcommand: "list" | "show" | "purge";
  file?: string;
  id?: string;
  olderThan?: string;
  yes: boolean;
  json: boolean;
  chatId?: string;
}

export function parseDlqArgs(argv: string[]): ParsedCliArgs {
  const [subcommand, ...rest] = argv;
  if (subcommand !== "list" && subcommand !== "show" && subcommand !== "purge") {
    throw new DlqUsageError(USAGE);
  }

  const parsed: ParsedCliArgs = {
    subcommand,
    yes: false,
    json: false,
  };
  const seen = new Set<string>();

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;

    if (arg === "--yes") {
      if (subcommand !== "purge") {
        throw new DlqUsageError(`--yes is only valid with purge\n${USAGE}`);
      }
      if (seen.has(arg)) throw new DlqUsageError(`duplicate ${arg} option\n${USAGE}`);
      seen.add(arg);
      parsed.yes = true;
      continue;
    }

    if (arg === "--json") {
      if (seen.has(arg)) throw new DlqUsageError(`duplicate ${arg} option\n${USAGE}`);
      seen.add(arg);
      parsed.json = true;
      continue;
    }

    if (arg === "--file" || arg === "--older-than" || arg === "--chat-id") {
      if (arg === "--older-than" && subcommand !== "purge") {
        throw new DlqUsageError(`--older-than is only valid with purge\n${USAGE}`);
      }
      if (seen.has(arg)) throw new DlqUsageError(`duplicate ${arg} option\n${USAGE}`);
      seen.add(arg);
      const value = rest[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new DlqUsageError(`${arg} requires a value\n${USAGE}`);
      }
      if (arg === "--file") parsed.file = value;
      else if (arg === "--older-than") parsed.olderThan = value;
      else if (arg === "--chat-id") parsed.chatId = value;
      i += 1;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new DlqUsageError(`unknown option: ${arg}\n${USAGE}`);
    }

    if (subcommand === "show" && parsed.id === undefined) {
      parsed.id = arg;
      continue;
    }

    throw new DlqUsageError(`unexpected argument: ${arg}\n${USAGE}`);
  }

  if (subcommand === "show" && (!parsed.id || parsed.id.trim() === "")) {
    throw new DlqUsageError(`show requires an entry <id>\n${USAGE}`);
  }

  if (parsed.olderThan !== undefined) {
    parseDurationMs(parsed.olderThan);
  }

  return parsed;
}

function resolvePath(value: string): string {
  return path.resolve(process.cwd(), value);
}

function formatListOutput(
  entries: DlqEntryView[],
  filePath: string,
  chatId: string,
  asJson: boolean,
): string {
  if (asJson) {
    return `${JSON.stringify({ file: filePath, chatId, depth: entries.length, entries }, null, 2)}\n`;
  }
  if (entries.length === 0) {
    return `[dlq] 0 entries (chat=${chatId}) in ${filePath}`;
  }
  const lines = [
    `[dlq] ${entries.length} entry(s) (chat=${chatId}) in ${filePath}`,
    ...entries.map(
      (e) =>
        `  ${e.id}  enqueued=${e.enqueuedAt}  source=${e.source}  ledger=${e.ledger}  ` +
        `event=${e.eventName}  attempts=${e.attempts}  chat=${e.chatId}  ` +
        `lastError=${boundText(e.lastError ?? "none", 120)}`,
    ),
  ];
  return lines.join("\n");
}

function formatShowOutput(entry: DlqEntryView, asJson: boolean): string {
  if (asJson) {
    return `${JSON.stringify(entry, null, 2)}\n`;
  }
  return [
    `id:         ${entry.id}`,
    `enqueuedAt: ${entry.enqueuedAt}`,
    `source:     ${entry.source}`,
    `ledger:     ${entry.ledger}`,
    `eventName:  ${entry.eventName}`,
    `attempts:   ${entry.attempts}`,
    `chatId:     ${entry.chatId}`,
    `lastError:  ${entry.lastError ?? "none"}`,
    `text:\n${entry.text}`,
  ].join("\n");
}

function formatPurgeOutput(
  result: PurgeDlqResult,
  filePath: string,
  asJson: boolean,
): string {
  if (asJson) {
    return `${JSON.stringify({ file: filePath, ...result }, null, 2)}\n`;
  }
  if (result.dryRun) {
    return (
      `[dlq] dry-run: would purge ${result.purged} entry(s), ${result.remaining} remaining ` +
      `(chat=${result.chatId}) in ${filePath}; pass --yes to write`
    );
  }
  return (
    `[dlq] purged ${result.purged} entry(s), ${result.remaining} remaining ` +
    `(chat=${result.chatId}) in ${filePath}`
  );
}

export interface RunDlqCliOptions {
  argv?: string[];
  now?: () => number;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

export async function runDlqCli(
  options: RunDlqCliOptions = {},
): Promise<{ exitCode: number }> {
  const argv = options.argv ?? process.argv.slice(2);
  const out = options.stdout ?? ((line: string) => console.log(line));
  const errOut = options.stderr ?? ((line: string) => console.error(line));
  const wantsJson = argv.includes("--json");

  const emitFailure = (
    exitCode: DlqExitCode,
    code: string,
    message: string,
    preserveNewlines = false,
  ): { exitCode: number } => {
    const formattedMsg = preserveNewlines ? message : boundText(message, 300);
    errOut(`[dlq] ${formattedMsg}`);
    if (wantsJson) {
      out(
        JSON.stringify(
          {
            ok: false,
            error: {
              code,
              exitCode,
              message: boundText(message, 300),
            },
          },
          null,
          2,
        ),
      );
    }
    return { exitCode };
  };

  let parsed: ParsedCliArgs;
  try {
    parsed = parseDlqArgs(argv);
  } catch (err) {
    const message = err instanceof Error ? err.message : USAGE;
    return emitFailure(DLQ_EXIT_CODES.USAGE_ERROR, "USAGE_ERROR", message, true);
  }

  const filePath = resolvePath(
    parsed.file ?? process.env.DEAD_LETTER_FILE ?? "./data/dead-letter.json",
  );
  const commonOptions: ListDlqOptions = {
    filePath,
    chatId: parsed.chatId,
    now: options.now,
  };

  try {
    if (parsed.subcommand === "list") {
      const entries = await listDeadLetters(commonOptions);
      const chatId = resolveChatIdForSource("default", parsed.chatId);
      out(formatListOutput(entries, filePath, chatId, parsed.json).trimEnd());
      return { exitCode: DLQ_EXIT_CODES.OK };
    }

    if (parsed.subcommand === "show") {
      const entry = await showDeadLetter({ ...commonOptions, id: parsed.id! });
      out(formatShowOutput(entry, parsed.json).trimEnd());
      return { exitCode: DLQ_EXIT_CODES.OK };
    }

    const result = await purgeDeadLetters({
      ...commonOptions,
      olderThan: parsed.olderThan,
      yes: parsed.yes,
    });
    out(formatPurgeOutput(result, filePath, parsed.json).trimEnd());
    return { exitCode: DLQ_EXIT_CODES.OK };
  } catch (err) {
    if (err instanceof DlqUsageError) {
      return emitFailure(err.exitCode, err.code, err.message, true);
    }
    if (err instanceof DlqUnknownEntryError) {
      return emitFailure(err.exitCode, err.code, err.message);
    }
    if (err instanceof DlqMalformedFileError) {
      return emitFailure(err.exitCode, err.code, err.message);
    }
    if (err instanceof DlqAccessError) {
      return emitFailure(err.exitCode, err.code, err.message);
    }
    const message = err instanceof Error ? err.message : "dlq command failed";
    return emitFailure(DLQ_EXIT_CODES.ACCESS_FAILURE, "ACCESS_FAILURE", message);
  }
}

async function main(): Promise<void> {
  loadDotenv({ path: process.env.DOTENV_CONFIG_PATH || ".env", quiet: true });
  const { exitCode } = await runDlqCli();
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : "dlq command failed";
    console.error(`[dlq] ${message.replace(/\s+/g, " ").slice(0, 300)}`);
    process.exit(1);
  });
}
