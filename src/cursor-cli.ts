/*
 * Offline cursor backup and restore command. It never contacts Stellar or
 * Telegram; restore uses the normal instance lock to exclude a running poller.
 */

import { randomUUID } from "node:crypto";
import { access, link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { pathToFileURL } from "node:url";

import { acquireInstanceLock } from "./instanceLock.js";
import {
  appendCursorRecoveryRecord,
  type CursorRecoveryPosition,
  type CursorRecoveryReason,
  type CursorRecoveryRecord,
  type CursorRecoveryTargetTransition,
  MAX_CURSOR_RECOVERY_HISTORY,
  parseAndMigrateCursorFile,
  sanitizeCursorRecoveryHistory,
  summarizeCursorRecoveryPosition,
} from "./poller.js";

export {
  appendCursorRecoveryRecord,
  type CursorRecoveryPosition,
  type CursorRecoveryReason,
  type CursorRecoveryRecord,
  type CursorRecoveryTargetTransition,
  MAX_CURSOR_RECOVERY_HISTORY,
  sanitizeCursorRecoveryHistory,
  summarizeCursorRecoveryPosition,
};

export interface BackupCursorOptions {
  cursorFile: string;
  backupFile: string;
  force?: boolean;
}

export interface RestoreCursorOptions extends BackupCursorOptions {
  lockFile: string;
  now?: () => Date;
  maxHistory?: number;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

function validateCursor(raw: string): ReturnType<typeof parseAndMigrateCursorFile> {
  try {
    return parseAndMigrateCursorFile(raw);
  } catch {
    throw new Error("cursor file is malformed or uses an unsupported schema");
  }
}

async function writeAtomic(filePath: string, contents: string, replace: boolean): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;

  try {
    await writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx" });
    if (replace) {
      await rename(temporaryPath, filePath);
    } else {
      try {
        await link(temporaryPath, filePath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error(`destination already exists at ${filePath}; pass --force to overwrite`);
        }
        throw err;
      }
    }
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

/** Copy a validated supported cursor snapshot without exposing cursor values. */
export async function backupCursor(options: BackupCursorOptions): Promise<void> {
  const raw = await readFile(options.cursorFile, "utf8");
  const parsed = validateCursor(raw);
  if (!options.force && (await exists(options.backupFile))) {
    throw new Error(`backup already exists at ${options.backupFile}; pass --force to overwrite`);
  }
  await writeAtomic(options.backupFile, raw, options.force === true);
  console.log(
    `[cursor] backed up schema=v` + `${parsed.file.version} targets=${Object.keys(parsed.file.targets).length} ` +
      `from ${options.cursorFile} to ${options.backupFile}`,
  );
}

function mergePriorHistory(
  liveHistory: readonly CursorRecoveryRecord[] | undefined,
  backupHistory: readonly CursorRecoveryRecord[] | undefined,
  maxEntries: number,
): CursorRecoveryRecord[] {
  const combined = [...(liveHistory ?? []), ...(backupHistory ?? [])];
  const seen = new Set<string>();
  const unique: CursorRecoveryRecord[] = [];
  for (const record of combined) {
    const key = `${record.at}|${record.reason}|${JSON.stringify(record.targets)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(record);
  }
  unique.sort((a, b) => a.at.localeCompare(b.at));
  return sanitizeCursorRecoveryHistory(unique, maxEntries);
}

/** Read the bounded recovery history from a cursor file without exposing raw cursors. */
export async function readCursorRecoveryHistory(
  cursorFile: string,
): Promise<CursorRecoveryRecord[]> {
  const raw = await readFile(cursorFile, "utf8");
  const parsed = validateCursor(raw);
  return sanitizeCursorRecoveryHistory(parsed.file.recoveryHistory);
}

/** Restore a compatible cursor while holding the poller's exclusive lock. */
export async function restoreCursor(options: RestoreCursorOptions): Promise<void> {
  const lock = await acquireInstanceLock(options.lockFile);
  try {
    const raw = await readFile(options.backupFile, "utf8");
    const parsed = validateCursor(raw);
    const liveExists = await exists(options.cursorFile);
    if (!options.force && liveExists) {
      throw new Error(`cursor already exists at ${options.cursorFile}; pass --force to replace it`);
    }

    const nowFn = options.now ?? (() => new Date());
    const maxHistory = options.maxHistory ?? MAX_CURSOR_RECOVERY_HISTORY;
    let liveTargets: Record<string, { cursor?: string | null; lastEventLedger?: number | null; rewindFromLedger?: number | null }> = {};
    let liveHistory: CursorRecoveryRecord[] = [];
    let liveUnreadable = false;

    if (liveExists) {
      try {
        const liveRaw = await readFile(options.cursorFile, "utf8");
        const liveParsed = parseAndMigrateCursorFile(liveRaw, { now: nowFn });
        liveTargets = liveParsed.file.targets;
        liveHistory = sanitizeCursorRecoveryHistory(liveParsed.file.recoveryHistory, maxHistory);
      } catch {
        liveUnreadable = true;
      }
    }

    const allTargetKeys = new Set<string>([
      ...Object.keys(liveTargets),
      ...Object.keys(parsed.file.targets),
    ]);
    const transitions: Record<string, CursorRecoveryTargetTransition> = {};
    for (const source of allTargetKeys) {
      const before: CursorRecoveryPosition = !liveExists
        ? { kind: "none", ledger: null, lastEventLedger: null }
        : liveUnreadable
          ? { kind: "unreadable", ledger: null, lastEventLedger: null }
          : summarizeCursorRecoveryPosition(liveTargets[source]);
      const after = summarizeCursorRecoveryPosition(parsed.file.targets[source]);
      transitions[source] = { before, after };
    }

    if (Object.keys(transitions).length > 0) {
      const prior = mergePriorHistory(liveHistory, parsed.file.recoveryHistory, maxHistory);
      parsed.file.recoveryHistory = appendCursorRecoveryRecord(
        prior,
        {
          at: nowFn().toISOString(),
          reason: "operator_restore",
          targets: transitions,
        },
        maxHistory,
      );
    }

    const normalized = `${JSON.stringify(parsed.file, null, 2)}\n`;
    await writeAtomic(options.cursorFile, normalized, options.force === true);
    console.log(
      `[cursor] restored schema=v${parsed.file.version} targets=${Object.keys(parsed.file.targets).length} ` +
        `from ${options.backupFile} to ${options.cursorFile}`,
    );
  } finally {
    await lock.release();
  }
}

interface CliOptions {
  file?: string;
  out?: string;
  from?: string;
  force: boolean;
  json: boolean;
}

function parseOptions(args: string[]): CliOptions {
  const options: CliOptions = { force: false, json: false };
  const seen = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--force") {
      if (seen.has(arg)) throw new Error("duplicate --force option");
      seen.add(arg);
      options.force = true;
      continue;
    }
    if (arg === "--json") {
      if (seen.has(arg)) throw new Error("duplicate --json option");
      seen.add(arg);
      options.json = true;
      continue;
    }
    if (arg !== "--file" && arg !== "--out" && arg !== "--from") {
      throw new Error(`unknown option: ${arg}`);
    }
    if (seen.has(arg)) throw new Error(`duplicate ${arg} option`);
    seen.add(arg);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a path`);
    options[arg.slice(2) as "file" | "out" | "from"] = value;
    index += 1;
  }

  return options;
}

function resolvePath(value: string): string {
  return path.resolve(process.cwd(), value);
}

function assertDifferentPaths(left: string, right: string): void {
  const normalize = (value: string) =>
    process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  if (normalize(left) === normalize(right)) {
    throw new Error("backup and live cursor paths must be different");
  }
}

async function main(): Promise<void> {
  loadDotenv({ path: process.env.DOTENV_CONFIG_PATH || ".env" });
  const [action, ...args] = process.argv.slice(2);
  if (action !== "backup" && action !== "restore" && action !== "history") {
    throw new Error(
      "usage: npm run cursor -- <backup|restore|history> [--file PATH] [--out PATH|--from PATH] [--force] [--json]",
    );
  }

  const options = parseOptions(args);
  const cursorFile = resolvePath(options.file ?? process.env.CURSOR_FILE ?? "./data/cursor.json");
  if (action === "history") {
    const records = await readCursorRecoveryHistory(cursorFile);
    if (options.json) {
      console.log(JSON.stringify({ cursorFile, count: records.length, records }, null, 2));
      return;
    }
    console.log(`[cursor] recovery history count=${records.length} file=${cursorFile}`);
    for (const record of records) {
      const summary = Object.entries(record.targets)
        .map(
          ([source, tr]) =>
            `${source}:${tr.before.kind}${tr.before.ledger !== null ? `@${tr.before.ledger}` : ""}->` +
            `${tr.after.kind}${tr.after.ledger !== null ? `@${tr.after.ledger}` : ""}`,
        )
        .join(" ");
      console.log(`  ${record.at} reason=${record.reason} ${summary}`);
    }
    return;
  }

  if (action === "backup") {
    const backupFile = resolvePath(
      options.out ?? `${cursorFile}.${new Date().toISOString().replace(/[:.]/g, "-")}.bak`,
    );
    assertDifferentPaths(cursorFile, backupFile);
    await backupCursor({ cursorFile, backupFile, force: options.force });
    return;
  }

  if (!options.from) throw new Error("restore requires --from PATH");
  const backupFile = resolvePath(options.from);
  assertDifferentPaths(cursorFile, backupFile);
  const lockFile = resolvePath(process.env.INSTANCE_LOCK_FILE ?? "./data/poller.lock");
  await restoreCursor({
    cursorFile,
    backupFile,
    lockFile,
    force: options.force,
  });
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : "cursor command failed";
    console.error(`[cursor] ${message.replace(/\s+/g, " ").slice(0, 300)}`);
    process.exit(1);
  });
}
