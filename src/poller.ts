/**
 * The poll loop: read new contract events, notify, persist the cursor.
 *
 * ── Failure policy ───────────────────────────────────────────────────────────
 *
 * This process is meant to stay up for weeks. Nothing in one cycle may end it
 * *unless* a supervisor is present and the failure count crosses the configured
 * threshold, at which point a deliberate exit (code 3) hands control back to
 * the supervisor for a clean restart with fresh connections and reset state.
 *
 *  - A failed RPC call fails ONE contract's scan for ONE cycle. Its cursor is
 *    left untouched, so the next cycle picks up exactly where it stopped.
 *  - When ALL targets fail for N consecutive cycles, the loop applies
 *    exponential back-off (capped at `pollIntervalMs`) before each retry.
 *    If `consecutiveFailureExitThreshold > 0` and the counter reaches it,
 *    the process exits with EXIT_RPC_PERSISTENT (3) for supervisor restart.
 *  - A failed Telegram send drops ONE message. The cursor still advances.
 *    That is deliberate: holding the cursor back on a send failure means a
 *    broken bot token or a chat the bot was kicked from turns into an infinite
 *    replay of the same events forever, and recovering floods the channel.
 *    Notifications are lossy by design; the chain remains the record.
 *  - Telegram HTTP 429 (rate-limited) causes the send to wait out the
 *    `retry_after` interval the API supplies (or TELEGRAM_429_BACKOFF_MS if
 *    absent) before the *next* send in the same cycle, without dropping the
 *    current message.
 *  - A stale cursor is one whose embedded ledger has not advanced past the
 *    RPC's `oldestLedger` after `STALE_CURSOR_LEDGER_GRACE` cycles. That
 *    means the retained window has scrolled past our resume point — the bot
 *    would read zero events for all time. The stale flag is exposed on
 *    PollerStatus so the health endpoint and /status command can surface it.
 *    The cursor is automatically dropped to force a cold-start re-sync.
 *  - A cursor file that cannot be read is treated as a cold start; one that
 *    cannot be written is logged, and the in-memory cursor keeps working until
 *    the next restart.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { rpc } from "@stellar/stellar-sdk";

import type { BotConfig } from "./config.js";
import { EXIT_RPC_PERSISTENT } from "./exitCodes.js";
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
  /**
   * True when this target's cursor is no longer within the RPC's retained
   * window. The cursor has been cleared and the next cycle will cold-start.
   */
  staleCursor: boolean;
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
  /**
   * Current back-off delay applied between cycles when all targets are
   * failing (ms). 0 when the poller is healthy.
   */
  currentBackoffMs: number;
  /**
   * True when at least one target had its stale cursor cleared this run.
   * Cleared once a successful scan is seen from that target.
   */
  anyStaleCursor: boolean;
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
   * Called when the consecutive-failure counter reaches the configured
   * threshold. Defaults to `process.exit(EXIT_RPC_PERSISTENT)`.
   * Overrideable in tests.
   */
  onPersistentFailure?: () => void;
}

/** Telegram tolerates ~20 messages/minute to one chat; stay under it. */
const SEND_SPACING_MS = 1_500;

/**
 * Default Telegram 429 back-off when the API does not supply a `retry_after`
 * value. 30 s is a conservative safe floor.
 */
const TELEGRAM_429_BACKOFF_MS = 30_000;

/**
 * Number of cycles during which a cursor may remain behind `oldestLedger`
 * before it is declared stale and cleared. One or two empty cycles can be
 * normal during an RPC rolling-window boundary; a grace window avoids
 * spurious cold-starts on brief fluctuations.
 */
const STALE_CURSOR_GRACE_CYCLES = 3;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * If the error looks like a Telegram 429, return the number of seconds to
 * wait before the next request (from `parameters.retry_after`), otherwise
 * return null.
 */
function telegram429RetryAfter(err: unknown): number | null {
  if (!(err instanceof Error)) return null;
  // grammy wraps Telegram errors as GrammyError with an `error_code` property.
  const maybe = err as { error_code?: unknown; parameters?: { retry_after?: unknown } };
  if (maybe.error_code !== 429) return null;
  const retryAfter = maybe.parameters?.retry_after;
  if (typeof retryAfter === "number" && retryAfter > 0) return retryAfter;
  return TELEGRAM_429_BACKOFF_MS / 1000;
}

export function createPoller(deps: PollerDeps) {
  const { config, server, send } = deps;
  const onPersistentFailure =
    deps.onPersistentFailure ??
    (() => {
      process.exit(EXIT_RPC_PERSISTENT);
    });

  const targets: WatchTarget[] = [
    { source: "market", contractId: config.marketContractId },
    { source: "squad", contractId: config.squadContractId },
  ];

  const state = new Map<ContractSource, TargetState>(
    targets.map((t) => [
      t.source,
      {
        source: t.source,
        contractId: t.contractId,
        cursor: null,
        lastEventLedger: null,
        lastError: null,
        staleCursor: false,
      },
    ]),
  );

  /** Per-target stale counter: how many consecutive cycles the cursor has been behind oldestLedger. */
  const staleCycleCount = new Map<ContractSource, number>(targets.map((t) => [t.source, 0]));

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
    currentBackoffMs: 0,
    anyStaleCursor: false,
  };

  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let inFlight = false;

  // ── Cursor persistence ─────────────────────────────────────────────────────

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
      const parsed = JSON.parse(raw) as CursorFile;
      for (const [source, saved] of Object.entries(parsed.targets ?? {})) {
        const target = state.get(source as ContractSource);
        if (!target) continue;
        target.cursor = saved.cursor ?? null;
        target.lastEventLedger = saved.lastEventLedger ?? null;
      }
      console.log(
        `[poller] resumed from ${config.cursorFile}: ` +
          [...state.values()].map((t) => `${t.source}@${t.cursor ?? "none"}`).join(" "),
      );
    } catch (err) {
      // A corrupt state file must not wedge the bot; a cold start is recoverable.
      console.warn(`[poller] cursor file unreadable, starting cold: ${errMessage(err)}`);
    }
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

    try {
      await mkdir(path.dirname(config.cursorFile), { recursive: true });
      // Write-then-rename: a crash mid-write must not leave a truncated file
      // that sends the next start back to the beginning of the retained window.
      const tmp = `${config.cursorFile}.tmp`;
      await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      await rename(tmp, config.cursorFile);
    } catch (err) {
      console.error(`[poller] could not persist cursor: ${errMessage(err)}`);
    }
  }

  // ── Stale-cursor detection ─────────────────────────────────────────────────

  /**
   * A cursor is stale when its embedded ledger is strictly less than the RPC's
   * `oldestLedger`. That means the retained window has scrolled past our
   * resume point — any subsequent scan will start from `oldestLedger` anyway,
   * so we should make that explicit rather than silently re-notifying from the
   * oldest available event.
   *
   * We give it STALE_CURSOR_GRACE_CYCLES cycles before acting, because a
   * single empty scan at a rolling-window boundary is not unusual.
   */
  function checkStaleCursor(target: TargetState, oldestLedger: number): void {
    if (!target.cursor) {
      staleCycleCount.set(target.source, 0);
      return;
    }

    // Extract the ledger embedded in the Soroban cursor TOID.
    const toid = target.cursor.split("-")[0];
    if (!toid || !/^\d+$/.test(toid)) {
      staleCycleCount.set(target.source, 0);
      return;
    }
    const cursorLedger = Number(BigInt(toid) >> 32n);

    if (cursorLedger < oldestLedger) {
      const count = (staleCycleCount.get(target.source) ?? 0) + 1;
      staleCycleCount.set(target.source, count);

      if (count >= STALE_CURSOR_GRACE_CYCLES) {
        console.warn(
          `[poller] ${target.source}: cursor ledger ${cursorLedger} is behind ` +
            `oldest retained ledger ${oldestLedger} for ${count} cycle(s); ` +
            `clearing cursor for cold-start re-sync`,
        );
        target.cursor = null;
        target.lastEventLedger = null;
        target.staleCursor = true;
        status.anyStaleCursor = true;
        staleCycleCount.set(target.source, 0);
      } else {
        console.warn(
          `[poller] ${target.source}: cursor ledger ${cursorLedger} behind oldest ${oldestLedger} ` +
            `(${count}/${STALE_CURSOR_GRACE_CYCLES} grace cycles)`,
        );
      }
    } else {
      staleCycleCount.set(target.source, 0);
      if (target.staleCursor) {
        // Successful re-sync after a stale clear.
        target.staleCursor = false;
        status.anyStaleCursor = [...state.values()].some((t) => t.staleCursor);
      }
    }
  }

  // ── One cycle ──────────────────────────────────────────────────────────────

  async function notify(events: DecodedEvent[]): Promise<void> {
    let sentThisCycle = 0;
    let pending429Ms = 0;

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

      // Honour a previous 429 back-off before attempting the next send.
      if (pending429Ms > 0) {
        console.warn(`[poller] Telegram 429 back-off: waiting ${pending429Ms}ms`);
        await sleep(pending429Ms);
        pending429Ms = 0;
      }

      try {
        await send(text);
        status.notificationsSent += 1;
        sentThisCycle += 1;
      } catch (err) {
        const retryAfterSecs = telegram429RetryAfter(err);
        if (retryAfterSecs !== null) {
          // The message was not sent; keep it in the batch but record the
          // back-off so the next send is delayed. The current message is
          // dropped — same as any other send failure — but we don't flood
          // Telegram further.
          pending429Ms = retryAfterSecs * 1000;
          status.notificationsFailed += 1;
          console.warn(
            `[poller] Telegram 429 on ${event.payload.name} at ledger ${event.ledger}; ` +
              `retry_after=${retryAfterSecs}s`,
          );
        } else {
          // One bad send must not abort the rest of the batch.
          status.notificationsFailed += 1;
          console.error(
            `[poller] send failed for ${event.payload.name} at ledger ${event.ledger}: ` +
              errMessage(err),
          );
        }
      }

      if (sentThisCycle < config.maxNotificationsPerCycle && pending429Ms === 0) {
        await sleep(SEND_SPACING_MS);
      }
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

        // Stale-cursor check runs on every successful scan so it catches the
        // condition even when the cursor has not moved (empty pages).
        checkStaleCursor(current, scan.oldestLedger);

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
      status.currentBackoffMs = 0;
    } else {
      status.consecutiveFailures += 1;

      // Exponential back-off: double the base on each consecutive failure,
      // capped at the configured poll interval so we don't drift too far.
      const backoff = Math.min(
        config.backoffBaseMs * Math.pow(2, status.consecutiveFailures - 1),
        config.pollIntervalMs,
      );
      status.currentBackoffMs = backoff;

      console.warn(
        `[poller] all targets failed (${status.consecutiveFailures} consecutive); ` +
          `back-off ${backoff}ms`,
      );

      // Check the exit threshold *after* updating the counter and back-off so
      // that the status snapshot written below is accurate.
      if (
        config.consecutiveFailureExitThreshold > 0 &&
        status.consecutiveFailures >= config.consecutiveFailureExitThreshold
      ) {
        console.error(
          `[poller] consecutive failure threshold (${config.consecutiveFailureExitThreshold}) ` +
            `reached; requesting supervisor restart (exit ${EXIT_RPC_PERSISTENT})`,
        );
        status.targets = [...state.values()].map((t) => ({ ...t }));
        await saveCursors();
        inFlight = false;
        onPersistentFailure();
        return;
      }
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

    // When in back-off mode, delay the next iteration by the accumulated
    // back-off on top of the normal poll interval.
    const delay = config.pollIntervalMs + status.currentBackoffMs;
    timer = setTimeout(() => void loop(), delay);
  }

  return {
    async start(): Promise<void> {
      await loadCursors();
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
