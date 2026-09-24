/**
 * The poll loop: read new contract events, notify, persist the cursor.
 *
 * ── Failure policy ───────────────────────────────────────────────────────────
 *
 * This process is meant to stay up for weeks. Nothing in one cycle may end it:
 *
 *  - A failed RPC call fails ONE contract's scan for ONE cycle. Its cursor is
 *    left untouched, so the next cycle picks up exactly where it stopped.
 *  - A failed Telegram send drops ONE message. The cursor still advances.
 *    That is deliberate: holding the cursor back on a send failure means a
 *    broken bot token or a chat the bot was kicked from turns into an infinite
 *    replay of the same events forever, and recovering floods the channel.
 *    Notifications are lossy by design; the chain remains the record.
 *  - A cursor file that cannot be read is treated as a cold start; one that
 *    cannot be written is logged, and the in-memory cursor keeps working until
 *    the next restart.
 *  - Legacy (unversioned / flat) cursor files are migrated in-place to the
 *    current versioned schema on load; unknown future versions are rejected
 *    so a downgrade cannot silently mis-read a newer file.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { rpc } from "@stellar/stellar-sdk";

import type { BotConfig } from "./config.js";
import { formatEvent } from "./notifications/format.js";
import { readContractEvents, type WatchTarget } from "./stellar/events.js";
import type { ContractSource, DecodedEvent } from "./stellar/decode.js";

/** Current on-disk cursor schema. Bump when the shape of `targets` changes. */
export const CURSOR_SCHEMA_VERSION = 1 as const;

export interface CursorTargetEntry {
  cursor: string | null;
  lastEventLedger: number | null;
}

export interface CursorFile {
  version: typeof CURSOR_SCHEMA_VERSION;
  updatedAt: string;
  targets: Record<string, CursorTargetEntry>;
}

/** Where a loaded cursor document came from before normalisation. */
export type CursorSchemaSource =
  | "v1"
  | "legacy-unversioned"
  | "legacy-flat"
  | "legacy-string-map";

export interface CursorMigrateResult {
  file: CursorFile;
  /** True when the on-disk document was rewritten into the current schema. */
  migrated: boolean;
  source: CursorSchemaSource;
}

export interface TargetState {
  source: ContractSource;
  contractId: string;
  cursor: string | null;
  /** Highest ledger an event was seen in, from this run or the cursor file. */
  lastEventLedger: number | null;
  lastError: string | null;
}

export interface PollerStatus {
  running: boolean;
  startedAt: number;
  cycles: number;
  lastPollAt: number | null;
  lastSuccessAt: number | null;
  latestLedger: number | null;
  oldestLedger: number | null;
  notificationsSent: number;
  notificationsFailed: number;
  eventsSkipped: number;
  consecutiveFailures: number;
  lastError: { at: number; message: string } | null;
  targets: TargetState[];
}

export interface PollerDeps {
  config: BotConfig;
  server: rpc.Server;
  /** Sends one already-formatted MarkdownV2 message. May reject. */
  send: (text: string) => Promise<void>;
  /** Optional clock for deterministic `updatedAt` in tests. */
  now?: () => Date;
}

/** Telegram tolerates ~20 messages/minute to one chat; stay under it. */
const SEND_SPACING_MS = 1_500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeTargetEntry(value: unknown, label: string): CursorTargetEntry {
  if (typeof value === "string") {
    return { cursor: value.length > 0 ? value : null, lastEventLedger: null };
  }
  if (!isPlainObject(value)) {
    throw new Error(`${label}: target entry must be an object or cursor string`);
  }

  let cursor: string | null = null;
  if (value.cursor === null || value.cursor === undefined) {
    cursor = null;
  } else if (typeof value.cursor === "string") {
    cursor = value.cursor.length > 0 ? value.cursor : null;
  } else {
    throw new Error(`${label}: cursor must be a string or null`);
  }

  let lastEventLedger: number | null = null;
  if (value.lastEventLedger === null || value.lastEventLedger === undefined) {
    lastEventLedger = null;
  } else if (
    typeof value.lastEventLedger === "number" &&
    Number.isFinite(value.lastEventLedger) &&
    Number.isInteger(value.lastEventLedger)
  ) {
    lastEventLedger = value.lastEventLedger;
  } else {
    throw new Error(`${label}: lastEventLedger must be an integer or null`);
  }

  return { cursor, lastEventLedger };
}

function normalizeTargets(
  targets: Record<string, unknown>,
  label: string,
): Record<string, CursorTargetEntry> {
  const out: Record<string, CursorTargetEntry> = {};
  for (const [source, saved] of Object.entries(targets)) {
    out[source] = normalizeTargetEntry(saved, `${label}.targets.${source}`);
  }
  return out;
}

/**
 * Detect whether a top-level object looks like a flat legacy cursor map
 * (`{ market: { cursor, lastEventLedger }, squad: ... }` or string values)
 * rather than the versioned `{ version, targets }` envelope.
 */
function looksLikeFlatLegacyTargets(parsed: Record<string, unknown>): boolean {
  if ("targets" in parsed || "version" in parsed) return false;
  const keys = Object.keys(parsed);
  if (keys.length === 0) return false;
  // Ignore purely metadata-looking keys if somehow present alone.
  const dataKeys = keys.filter((k) => k !== "updatedAt");
  if (dataKeys.length === 0) return false;
  return dataKeys.every((key) => {
    const value = parsed[key];
    return typeof value === "string" || isPlainObject(value);
  });
}

/**
 * Parse a cursor file document and migrate any supported legacy shape into the
 * current versioned schema. Throws on malformed JSON payloads or unknown
 * future schema versions (caller treats that as a cold start).
 */
export function parseAndMigrateCursorFile(
  raw: string,
  options: { now?: () => Date } = {},
): CursorMigrateResult {
  const parsedUnknown: unknown = JSON.parse(raw);
  if (!isPlainObject(parsedUnknown)) {
    throw new Error("cursor file root must be a JSON object");
  }
  const parsed = parsedUnknown;
  const nowIso = (options.now ?? (() => new Date()))().toISOString();

  // ── Current versioned schema ───────────────────────────────────────────────
  if (parsed.version === CURSOR_SCHEMA_VERSION) {
    if (!isPlainObject(parsed.targets)) {
      throw new Error("cursor file v1: targets field missing or not an object");
    }
    const targets = normalizeTargets(parsed.targets, "cursor file v1");
    const updatedAt =
      typeof parsed.updatedAt === "string" && parsed.updatedAt.length > 0
        ? parsed.updatedAt
        : nowIso;
    return {
      file: { version: CURSOR_SCHEMA_VERSION, updatedAt, targets },
      migrated: typeof parsed.updatedAt !== "string" || parsed.updatedAt.length === 0,
      source: "v1",
    };
  }

  // ── Unknown future / invalid version ─────────────────────────────────────
  if ("version" in parsed && parsed.version !== undefined && parsed.version !== null) {
    throw new Error(
      `cursor file: unsupported schema version ${String(parsed.version)} ` +
        `(this build understands version ${CURSOR_SCHEMA_VERSION})`,
    );
  }

  // ── Legacy: unversioned envelope with `targets` ────────────────────────────
  if (isPlainObject(parsed.targets)) {
    const targets = normalizeTargets(parsed.targets, "legacy-unversioned");
    return {
      file: { version: CURSOR_SCHEMA_VERSION, updatedAt: nowIso, targets },
      migrated: true,
      source: "legacy-unversioned",
    };
  }

  // ── Legacy: flat map of target → entry or cursor string ────────────────────
  if (looksLikeFlatLegacyTargets(parsed)) {
    const { updatedAt: _ignored, ...flat } = parsed;
    const allStrings = Object.values(flat).every((v) => typeof v === "string");
    const targets = normalizeTargets(flat, allStrings ? "legacy-string-map" : "legacy-flat");
    return {
      file: { version: CURSOR_SCHEMA_VERSION, updatedAt: nowIso, targets },
      migrated: true,
      source: allStrings ? "legacy-string-map" : "legacy-flat",
    };
  }

  throw new Error("cursor file: unrecognised shape (expected versioned targets map)");
}

/** Build the on-disk payload the poller always writes. */
export function buildCursorFile(
  targets: Iterable<{ source: string; cursor: string | null; lastEventLedger: number | null }>,
  updatedAt: string,
): CursorFile {
  return {
    version: CURSOR_SCHEMA_VERSION,
    updatedAt,
    targets: Object.fromEntries(
      [...targets].map((t) => [
        t.source,
        { cursor: t.cursor, lastEventLedger: t.lastEventLedger },
      ]),
    ),
  };
}

export function createPoller(deps: PollerDeps) {
  const { config, server, send } = deps;
  const now = deps.now ?? (() => new Date());

  const targets: WatchTarget[] = [
    { source: "market", contractId: config.marketContractId },
    { source: "squad", contractId: config.squadContractId },
  ];

  const state = new Map<ContractSource, TargetState>(
    targets.map((t) => [
      t.source,
      { source: t.source, contractId: t.contractId, cursor: null, lastEventLedger: null, lastError: null },
    ]),
  );

  const status: PollerStatus = {
    running: false,
    startedAt: 0,
    cycles: 0,
    lastPollAt: null,
    lastSuccessAt: null,
    latestLedger: null,
    oldestLedger: null,
    notificationsSent: 0,
    notificationsFailed: 0,
    eventsSkipped: 0,
    consecutiveFailures: 0,
    lastError: null,
    targets: [],
  };

  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let inFlight = false;
  /** Set when load migrates a legacy file so the first save rewrites disk ASAP. */
  let pendingRewrite = false;

  // ── Cursor persistence ─────────────────────────────────────────────────────

  function applyCursorFile(parsed: CursorFile): void {
    for (const [source, saved] of Object.entries(parsed.targets)) {
      const target = state.get(source as ContractSource);
      if (!target) continue;
      target.cursor = saved.cursor;
      target.lastEventLedger = saved.lastEventLedger;
    }
  }

  async function loadCursors(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(config.cursorFile, "utf8");
    } catch {
      console.log(
        `[poller] no cursor file at ${config.cursorFile}; cold start ` +
          `${config.startLookbackLedgers} ledgers behind the tip`,
      );
      return;
    }

    try {
      const result = parseAndMigrateCursorFile(raw, { now });
      applyCursorFile(result.file);
      if (result.migrated) {
        pendingRewrite = true;
        console.log(
          `[poller] migrated cursor file from ${result.source} → ` +
            `schema v${CURSOR_SCHEMA_VERSION} at ${config.cursorFile}`,
        );
      }
      console.log(
        `[poller] resumed from ${config.cursorFile}: ` +
          [...state.values()].map((t) => `${t.source}@${t.cursor ?? "none"}`).join(" "),
      );
    } catch (err) {
      // A corrupt / unsupported state file must not wedge the bot; a cold start
      // is recoverable. Never echo the raw payload (may be huge / unexpected).
      console.warn(`[poller] cursor file unreadable, starting cold: ${errMessage(err)}`);
    }
  }

  async function saveCursors(): Promise<void> {
    const payload = buildCursorFile(state.values(), now().toISOString());

    try {
      await mkdir(path.dirname(config.cursorFile), { recursive: true });
      // Write-then-rename: a crash mid-write must not leave a truncated file
      // that sends the next start back to the beginning of the retained window.
      const tmp = `${config.cursorFile}.tmp`;
      await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      await rename(tmp, config.cursorFile);
      pendingRewrite = false;
    } catch (err) {
      console.error(`[poller] could not persist cursor: ${errMessage(err)}`);
    }
  }

  // ── One cycle ──────────────────────────────────────────────────────────────

  async function notify(events: DecodedEvent[]): Promise<void> {
    let sentThisCycle = 0;

    for (const event of events) {
      if (event.payload.name === "unknown") {
        status.eventsSkipped += 1;
        console.log(
          `[poller] skipped ${event.source} event "${event.payload.eventName}" ` +
            `at ledger ${event.ledger}${event.payload.reason ? ` (${event.payload.reason})` : ""}`,
        );
        continue;
      }

      const text = formatEvent(config, event);
      if (text === null) {
        status.eventsSkipped += 1;
        continue;
      }

      if (sentThisCycle >= config.maxNotificationsPerCycle) {
        status.eventsSkipped += 1;
        console.warn(
          `[poller] cycle notification cap (${config.maxNotificationsPerCycle}) reached; ` +
            `dropping ${event.payload.name} at ledger ${event.ledger}`,
        );
        continue;
      }

      try {
        await send(text);
        status.notificationsSent += 1;
        sentThisCycle += 1;
      } catch (err) {
        // One bad send must not abort the rest of the batch.
        status.notificationsFailed += 1;
        console.error(
          `[poller] send failed for ${event.payload.name} at ledger ${event.ledger}: ` +
            errMessage(err),
        );
      }

      if (sentThisCycle < config.maxNotificationsPerCycle) await sleep(SEND_SPACING_MS);
    }
  }

  async function cycle(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    status.cycles += 1;
    status.lastPollAt = Date.now();

    let anyOk = false;

    for (const target of targets) {
      const current = state.get(target.source);
      if (!current) continue;

      try {
        const scan = await readContractEvents(server, target, {
          cursor: current.cursor ?? undefined,
          lookbackLedgers: current.cursor ? undefined : config.startLookbackLedgers,
        });

        status.latestLedger = scan.latestLedger;
        status.oldestLedger = scan.oldestLedger;
        current.lastError = null;
        anyOk = true;

        if (scan.events.length > 0) {
          console.log(
            `[poller] ${target.source}: ${scan.events.length} event(s) ` +
              `up to ledger ${scan.lastEventLedger} in ${scan.pages} page(s)`,
          );
          await notify(scan.events);
        }

        if (scan.lastEventLedger !== null) current.lastEventLedger = scan.lastEventLedger;
        // Advance last — see the failure policy at the top of this file.
        if (scan.cursor) current.cursor = scan.cursor;
      } catch (err) {
        const message = errMessage(err);
        current.lastError = message;
        status.lastError = { at: Date.now(), message: `${target.source}: ${message}` };
        console.error(`[poller] ${target.source} scan failed: ${message}`);
      }
    }

    if (anyOk) {
      status.lastSuccessAt = Date.now();
      status.consecutiveFailures = 0;
    } else {
      status.consecutiveFailures += 1;
    }

    status.targets = [...state.values()].map((t) => ({ ...t }));
    await saveCursors();
    inFlight = false;
  }

  async function loop(): Promise<void> {
    if (stopped) return;
    try {
      await cycle();
    } catch (err) {
      // Belt and braces: `cycle` already swallows per-target failures, so this
      // only fires on a bug. Either way the loop survives it.
      status.consecutiveFailures += 1;
      status.lastError = { at: Date.now(), message: errMessage(err) };
      console.error(`[poller] cycle threw: ${errMessage(err)}`);
      inFlight = false;
    }
    if (stopped) return;
    timer = setTimeout(() => void loop(), config.pollIntervalMs);
  }

  return {
    async start(): Promise<void> {
      await loadCursors();
      // Persist a migrated schema before the first cycle so a crash mid-poll
      // still leaves a versioned file behind for the next restart.
      if (pendingRewrite) {
        await saveCursors();
      }
      status.running = true;
      status.startedAt = Date.now();
      status.targets = [...state.values()].map((t) => ({ ...t }));
      console.log(
        `[poller] watching market=${config.marketContractId} squad=${config.squadContractId} ` +
          `every ${config.pollIntervalMs}ms`,
      );
      void loop();
    },

    stop(): void {
      stopped = true;
      status.running = false;
      if (timer) clearTimeout(timer);
      timer = null;
    },

    status(): PollerStatus {
      return { ...status, targets: [...state.values()].map((t) => ({ ...t })) };
    },
  };
}

export type Poller = ReturnType<typeof createPoller>;
