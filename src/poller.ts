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
 *  - A cursor whose embedded ledger falls below the RPC's retained floor
 *    (plus CURSOR_STALE_LEDGER_MARGIN) is treated as stale. The bot falls back
 *    to a cold start rather than issuing a `startLedger` request below the
 *    floor (which is an RPC error, not an empty result).
 *
 * ── Cursor backup ────────────────────────────────────────────────────────────
 *
 * Each successful save writes:
 *   cursor.json.tmp  →  rename  →  cursor.json   (primary, atomic)
 *   cursor.json      →  copy   →  cursor.json.bak (backup, written after primary)
 *
 * The .bak file is only ever written after the primary rename succeeds, so it
 * always reflects the last successfully committed state. On load, the primary
 * is tried first; if it is missing or corrupt the backup is tried with a
 * warning. If both fail, the bot starts cold.
 */

import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { rpc } from "@stellar/stellar-sdk";

import type { BotConfig } from "./config.js";
import { formatEvent } from "./notifications/format.js";
import { eventCursorLedger, readContractEvents, type WatchTarget } from "./stellar/events.js";
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
  /** Number of Telegram send failures in the current consecutive run. */
  consecutiveSendFailures: number;
  eventsSkipped: number;
  consecutiveFailures: number;
  /** Total RPC scan failures since startup (capped at 2^31 − 1). */
  rpcFailures: number;
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
  /**
   * Wall-clock milliseconds. Injected for testing; defaults to `Date.now`.
   * Used only for status timestamps, not for business logic.
   */
  now?: () => number;
}

/** Telegram tolerates ~20 messages/minute to one chat; stay under it. */
const SEND_SPACING_MS = 1_500;

/** Cap for bounded integer counters (i32 max). */
const COUNTER_CAP = 2_147_483_647;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Clamp a counter so it never overflows a signed 32-bit integer display. */
function inc(n: number): number {
  return Math.min(n + 1, COUNTER_CAP);
}

export function createPoller(deps: PollerDeps) {
  const { config, server, send } = deps;
  const now = deps.now ?? (() => Date.now());

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
    consecutiveSendFailures: 0,
    eventsSkipped: 0,
    consecutiveFailures: 0,
    rpcFailures: 0,
    lastError: null,
    targets: [],
  };

  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let inFlight = false;

  // ── Cursor persistence ─────────────────────────────────────────────────────

  /**
   * Try to parse a cursor file from raw JSON. Returns the parsed object or
   * throws with a descriptive message.
   */
  function parseCursorFile(raw: string, label: string): CursorFile {
    const parsed = JSON.parse(raw) as CursorFile;
    if (parsed.version !== 1) {
      throw new Error(`${label}: unexpected version ${String(parsed.version)}`);
    }
    if (typeof parsed.targets !== "object" || parsed.targets === null) {
      throw new Error(`${label}: targets field missing or not an object`);
    }
    return parsed;
  }

  /**
   * Apply a parsed CursorFile to the in-memory state map.
   * Returns a description of what was loaded for logging.
   */
  function applyCursorFile(parsed: CursorFile, oldestLedger: number): string {
    const staleCutoff = oldestLedger - config.cursorStaleLedgerMargin;
    const applied: string[] = [];
    const stale: string[] = [];

    for (const [source, saved] of Object.entries(parsed.targets ?? {})) {
      const target = state.get(source as ContractSource);
      if (!target) continue;

      const cursor = saved.cursor ?? null;

      // Check staleness: if the cursor's embedded ledger is below the RPC's
      // oldest retained ledger (with margin), it would cause an RPC error.
      if (cursor !== null) {
        const cursorLedger = eventCursorLedger(cursor);
        if (cursorLedger !== null && cursorLedger < staleCutoff) {
          stale.push(
            `${source} cursor at ledger ${cursorLedger} is below retained floor ` +
              `${oldestLedger} (margin ${config.cursorStaleLedgerMargin})`,
          );
          // Leave cursor null → cold start for this target
          continue;
        }
      }

      target.cursor = cursor;
      target.lastEventLedger = saved.lastEventLedger ?? null;
      applied.push(`${source}@${cursor ?? "none"}`);
    }

    for (const msg of stale) {
      console.warn(`[poller] stale cursor discarded — ${msg}; falling back to cold start`);
    }

    return applied.join(" ");
  }

  async function loadCursors(): Promise<void> {
    // We need the RPC's retained floor to check staleness. If getHealth fails,
    // proceed without the check — a stale cursor will surface as an RPC error
    // on the first scan, which is already handled gracefully.
    let oldestLedger = 0;
    try {
      const health = await server.getHealth();
      oldestLedger = health.oldestLedger;
    } catch (err) {
      console.warn(`[poller] could not fetch chain health for stale-cursor check: ${errMessage(err)}`);
    }

    const primaryFile = config.cursorFile;
    const backupFile = `${config.cursorFile}.bak`;

    for (const [filePath, label] of [
      [primaryFile, "primary"],
      [backupFile, "backup"],
    ] as const) {
      let raw: string;
      try {
        raw = await readFile(filePath, "utf8");
      } catch {
        // File absent — try the next candidate.
        continue;
      }

      try {
        const parsed = parseCursorFile(raw, label);
        const summary = applyCursorFile(parsed, oldestLedger);
        const detail = summary
          ? `resumed from ${label} ${filePath}: ${summary}`
          : `cursor file ${label} ${filePath} loaded but all cursors were stale or unknown; cold start`;
        console.log(`[poller] ${detail}`);
        if (label === "backup") {
          console.warn(
            `[poller] primary cursor file was missing or corrupt; loaded from backup. ` +
              `The primary will be re-created on the next successful save.`,
          );
        }
        return;
      } catch (err) {
        console.warn(`[poller] cursor file ${label} (${filePath}) unreadable: ${errMessage(err)}`);
        // Fall through to try backup.
      }
    }

    // Both files absent or corrupt → cold start.
    console.log(
      `[poller] no usable cursor file; cold start ` +
        `${config.startLookbackLedgers} ledgers behind the tip`,
    );
  }

  async function saveCursors(): Promise<void> {
    const payload: CursorFile = {
      version: 1,
      updatedAt: new Date().toISOString(),
      targets: Object.fromEntries(
        [...state.values()].map((t) => [
          t.source,
          { cursor: t.cursor, lastEventLedger: t.lastEventLedger },
        ]),
      ),
    };

    const primaryFile = config.cursorFile;
    const tmpFile = `${config.cursorFile}.tmp`;
    const backupFile = `${config.cursorFile}.bak`;

    try {
      await mkdir(path.dirname(primaryFile), { recursive: true });

      // Step 1: write to .tmp then atomically rename to primary.
      // A crash mid-write cannot truncate the primary.
      await writeFile(tmpFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      await rename(tmpFile, primaryFile);

      // Step 2: copy the now-confirmed primary to .bak.
      // Only reached when Step 1 fully succeeded, so .bak always reflects
      // the last committed state. Failure here is logged but not fatal.
      try {
        await copyFile(primaryFile, backupFile);
      } catch (err) {
        console.warn(`[poller] could not write cursor backup: ${errMessage(err)}`);
      }
    } catch (err) {
      console.error(`[poller] could not persist cursor: ${errMessage(err)}`);
    }
  }

  // ── One cycle ──────────────────────────────────────────────────────────────

  async function notify(events: DecodedEvent[]): Promise<void> {
    let sentThisCycle = 0;

    for (const event of events) {
      if (event.payload.name === "unknown") {
        status.eventsSkipped = inc(status.eventsSkipped);
        console.log(
          `[poller] skipped ${event.source} event "${event.payload.eventName}" ` +
            `at ledger ${event.ledger}${event.payload.reason ? ` (${event.payload.reason})` : ""}`,
        );
        continue;
      }

      const text = formatEvent(config, event);
      if (text === null) {
        status.eventsSkipped = inc(status.eventsSkipped);
        continue;
      }

      if (sentThisCycle >= config.maxNotificationsPerCycle) {
        status.eventsSkipped = inc(status.eventsSkipped);
        console.warn(
          `[poller] cycle notification cap (${config.maxNotificationsPerCycle}) reached; ` +
            `dropping ${event.payload.name} at ledger ${event.ledger}`,
        );
        continue;
      }

      try {
        await send(text);
        status.notificationsSent = inc(status.notificationsSent);
        status.consecutiveSendFailures = 0;
        sentThisCycle += 1;
      } catch (err) {
        // One bad send must not abort the rest of the batch.
        status.notificationsFailed = inc(status.notificationsFailed);
        status.consecutiveSendFailures = inc(status.consecutiveSendFailures);
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
    status.cycles = inc(status.cycles);
    status.lastPollAt = now();

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
        status.rpcFailures = inc(status.rpcFailures);
        status.lastError = { at: now(), message: `${target.source}: ${message}` };
        console.error(`[poller] ${target.source} scan failed: ${message}`);
      }
    }

    if (anyOk) {
      status.lastSuccessAt = now();
      status.consecutiveFailures = 0;
    } else {
      status.consecutiveFailures = inc(status.consecutiveFailures);
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
      status.consecutiveFailures = inc(status.consecutiveFailures);
      status.lastError = { at: now(), message: errMessage(err) };
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
      status.startedAt = now();
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
