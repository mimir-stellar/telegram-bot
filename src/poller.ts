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
 *  - When MAX_CONSECUTIVE_FAILURES (> 0) fully-failed cycles accumulate, the
 *    loop slows to 10× the normal interval until one cycle partially succeeds.
 *    The process never exits — a supervisor restart is the recovery path.
 *
 * ── Cursor backup ─────────────────────────────────────────────────────────────
 *
 * After a successful write-then-rename to `cursor.json`, a copy is made to
 * `cursor.json.bak`. On startup `loadCursors` tries the primary file first,
 * then falls back to the backup, so a single bad write cannot cause a full
 * cold start. If CURSOR_MAX_AGE_MS is set, a file older than that threshold
 * triggers a warning so a missed-persistent-volume deployment surfaces early.
 */

import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { rpc } from "@stellar/stellar-sdk";

import type { BotConfig } from "./config.js";
import { formatEvent } from "./notifications/format.js";
import { readContractEvents, type WatchTarget } from "./stellar/events.js";
import type { ContractSource, DecodedEvent } from "./stellar/decode.js";

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

interface CursorFile {
  version: 1;
  updatedAt: string;
  targets: Record<string, { cursor: string | null; lastEventLedger: number | null }>;
}

export interface PollerDeps {
  config: BotConfig;
  server: rpc.Server;
  /** Sends one already-formatted MarkdownV2 message. May reject. */
  send: (text: string) => Promise<void>;
  /** Injectable clock for testing (defaults to Date.now). */
  now?: () => number;
}

/** Telegram tolerates ~20 messages/minute to one chat; stay under it. */
const SEND_SPACING_MS = 1_500;

/**
 * Maximum bytes of a remote error message to include in logs or status.
 * An RPC or Telegram error body can be arbitrarily large; cap it so a status
 * response or a log line is never the thing that takes the bot down.
 */
const MAX_ERROR_MSG_BYTES = 200;

/**
 * The backoff multiplier applied when MAX_CONSECUTIVE_FAILURES is reached.
 * 10× pollIntervalMs means a 30 s interval becomes 5 minutes.
 */
const BACKOFF_MULTIPLIER = 10;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function errMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // Clip at the byte level so multi-byte sequences do not leave a broken
  // character at the boundary.
  if (Buffer.byteLength(raw, "utf8") <= MAX_ERROR_MSG_BYTES) return raw;
  return `${Buffer.from(raw, "utf8").subarray(0, MAX_ERROR_MSG_BYTES - 1).toString("utf8")}…`;
}

export function createPoller(deps: PollerDeps) {
  const { config, server, send } = deps;
  const nowFn = deps.now ?? (() => Date.now());

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

  // ── Cursor persistence ─────────────────────────────────────────────────────

  /**
   * Try to parse and apply a cursor file from `filePath`.
   * Returns true when a valid file was found, false when missing.
   * Throws on a parse or structural error so the caller can decide.
   */
  async function applyCursorFile(filePath: string): Promise<boolean> {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch {
      return false; // file missing — not an error, just absent
    }

    const parsed = JSON.parse(raw) as CursorFile;
    for (const [source, saved] of Object.entries(parsed.targets ?? {})) {
      const target = state.get(source as ContractSource);
      if (!target) continue;
      target.cursor = saved.cursor ?? null;
      target.lastEventLedger = saved.lastEventLedger ?? null;
    }
    return true;
  }

  async function checkCursorAge(filePath: string): Promise<void> {
    if (!config.cursorMaxAgeMs) return;
    try {
      const { mtime } = await stat(filePath);
      const ageMs = nowFn() - mtime.getTime();
      if (ageMs > config.cursorMaxAgeMs) {
        console.warn(
          `[poller] cursor file is ${Math.round(ageMs / 1000)}s old ` +
            `(CURSOR_MAX_AGE_MS=${config.cursorMaxAgeMs}ms) — ` +
            `is the data directory on a persistent volume?`,
        );
      }
    } catch {
      // Stat failed — not worth crashing for.
    }
  }

  async function loadCursors(): Promise<void> {
    // Try primary file first.
    try {
      const found = await applyCursorFile(config.cursorFile);
      if (found) {
        console.log(
          `[poller] resumed from ${config.cursorFile}: ` +
            [...state.values()].map((t) => `${t.source}@${t.cursor ?? "none"}`).join(" "),
        );
        await checkCursorAge(config.cursorFile);
        return;
      }
    } catch (err) {
      console.warn(`[poller] cursor file unreadable (${errMessage(err)}), trying backup…`);
    }

    // Fall back to the backup file.
    const backupFile = `${config.cursorFile}.bak`;
    try {
      const found = await applyCursorFile(backupFile);
      if (found) {
        console.warn(
          `[poller] primary cursor missing/corrupt; resumed from backup ${backupFile}: ` +
            [...state.values()].map((t) => `${t.source}@${t.cursor ?? "none"}`).join(" "),
        );
        await checkCursorAge(backupFile);
        return;
      }
    } catch (err) {
      console.warn(`[poller] backup cursor also unreadable: ${errMessage(err)}`);
    }

    console.log(
      `[poller] no cursor file at ${config.cursorFile}; cold start ` +
        `${config.startLookbackLedgers} ledgers behind the tip`,
    );
  }

  async function saveCursors(): Promise<void> {
    const payload: CursorFile = {
      version: 1,
      updatedAt: new Date(nowFn()).toISOString(),
      targets: Object.fromEntries(
        [...state.values()].map((t) => [
          t.source,
          { cursor: t.cursor, lastEventLedger: t.lastEventLedger },
        ]),
      ),
    };

    try {
      await mkdir(path.dirname(config.cursorFile), { recursive: true });
      // Write-then-rename: a crash mid-write must not leave a truncated file
      // that sends the next start back to the beginning of the retained window.
      const tmp = `${config.cursorFile}.tmp`;
      await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      await rename(tmp, config.cursorFile);
      // Copy the committed file to the backup. `copyFile` is not atomic
      // cross-filesystem, but the backup is always at least one generation
      // older than the primary — a crash here leaves the primary intact.
      const backupFile = `${config.cursorFile}.bak`;
      await copyFile(config.cursorFile, backupFile);
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

  async function runCycle(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    status.cycles += 1;
    status.lastPollAt = nowFn();

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
        status.lastError = { at: nowFn(), message: `${target.source}: ${message}` };
        console.error(`[poller] ${target.source} scan failed: ${message}`);
      }
    }

    if (anyOk) {
      status.lastSuccessAt = nowFn();
      status.consecutiveFailures = 0;
    } else {
      status.consecutiveFailures += 1;

      if (
        config.maxConsecutiveFailures > 0 &&
        status.consecutiveFailures >= config.maxConsecutiveFailures
      ) {
        const backoffMs = config.pollIntervalMs * BACKOFF_MULTIPLIER;
        console.error(
          `[poller] ${status.consecutiveFailures} consecutive fully-failed cycles ` +
            `(MAX_CONSECUTIVE_FAILURES=${config.maxConsecutiveFailures}). ` +
            `Backing off ${backoffMs}ms before next poll.`,
        );
        // The extra sleep happens inside the cycle so the loop itself stays
        // simple. inFlight is still true here, which is intentional: a
        // concurrent tick() from a test that arrives during the backoff sleep
        // is a no-op.
        await sleep(backoffMs);
      }
    }

    status.targets = [...state.values()].map((t) => ({ ...t }));
    await saveCursors();
    inFlight = false;
  }

  async function loop(): Promise<void> {
    if (stopped) return;
    try {
      await runCycle();
    } catch (err) {
      // Belt and braces: `runCycle` already swallows per-target failures, so
      // this only fires on a bug. Either way the loop survives it.
      status.consecutiveFailures += 1;
      status.lastError = { at: nowFn(), message: errMessage(err) };
      console.error(`[poller] cycle threw: ${errMessage(err)}`);
      inFlight = false;
    }
    if (stopped) return;
    timer = setTimeout(() => void loop(), config.pollIntervalMs);
  }

  return {
    async start(): Promise<void> {
      await loadCursors();
      status.running = true;
      status.startedAt = nowFn();
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

    /**
     * Run exactly one poll cycle and wait for it to finish.
     *
     * Intended for tests: drive the poller cycle-by-cycle without relying on
     * real timers or starting the loop. Safe to call while the loop is
     * running too — `inFlight` ensures at most one cycle at a time.
     */
    runCycle,

    /**
     * Load cursor state from disk without starting the poll loop.
     *
     * Intended for tests that need to verify cursor-loading behaviour
     * (backup promotion, stale detection) without the asynchronous loop
     * race that `start()` introduces.
     */
    loadCursors,
  };
}

export type Poller = ReturnType<typeof createPoller>;
