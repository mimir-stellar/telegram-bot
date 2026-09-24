/**
 * The poll loop: read new contract events, notify, persist the cursor.
 *
 * ── Failure policy ───────────────────────────────────────────────────────────
 *
 * This process is meant to stay up for weeks. Nothing in one cycle may end it:
 *
 *  - A failed RPC call fails ONE contract's scan for ONE cycle. Its cursor is
 *    left untouched, so the next cycle picks up exactly where it stopped.
 *  - A failed Telegram send (after bounded retries) enqueues ONE message on the
 *    local dead-letter queue and the cursor still advances. Holding the cursor
 *    back on a send failure would turn a broken bot token or a chat the bot
 *    was kicked from into an infinite replay of the same events forever.
 *    The DLQ is bounded and replayed on later cycles so transient outages can
 *    still deliver; the chain remains the record if the queue overflows.
 *  - A cursor file that cannot be read is treated as a cold start; one that
 *    cannot be written is logged, and the in-memory cursor keeps working until
 *    the next restart.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { rpc } from "@stellar/stellar-sdk";

import type { BotConfig } from "./config.js";
import { createDeadLetterQueue, type DeadLetterStats } from "./deadLetter.js";
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
  deadLetter: DeadLetterStats;
}

interface CursorFile {
  version: 1;
  updatedAt: string;
  targets: Record<string, { cursor: string | null; lastEventLedger: number | null }>;
}

export type ReadEventsFn = typeof readContractEvents;

export interface PollerDeps {
  config: BotConfig;
  server: rpc.Server;
  /** Sends one already-formatted MarkdownV2 message. May reject. */
  send: (text: string) => Promise<void>;
  /** Injectable for tests — defaults to the real Soroban walker. */
  readEvents?: ReadEventsFn;
  /** Injectable sleep for tests (skips real backoff / spacing). */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock for deterministic DLQ timestamps in tests. */
  now?: () => number;
  /** Override inter-send spacing (default 1500ms). Tests pass 0. */
  sendSpacingMs?: number;
  /** Override in-cycle send retries (default 3). Tests often pass 1. */
  maxSendRetries?: number;
}

/** Telegram tolerates ~20 messages/minute to one chat; stay under it. */
const SEND_SPACING_MS = 1_500;

/** Maximum number of retry attempts for a single Telegram send. */
const MAX_SEND_RETRIES = 3;

/** Initial backoff in milliseconds for Telegram send retries. */
const INITIAL_BACKOFF_MS = 1_000;

/** Maximum backoff in milliseconds for Telegram send retries. */
const MAX_BACKOFF_MS = 10_000;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Sends a message with bounded exponential backoff.
 *
 * If the Telegram API is temporarily unavailable (rate limit, network error,
 * or bad token), we retry a few times with increasing delays. This prevents
 * transient failures from dropping notifications while avoiding infinite
 * retries that would block the poller loop.
 */
async function sendWithRetry(
  send: (text: string) => Promise<void>,
  text: string,
  opts: {
    sleep: (ms: number) => Promise<void>;
    maxRetries: number;
  },
): Promise<void> {
  let attempt = 0;
  let backoff = INITIAL_BACKOFF_MS;

  while (true) {
    try {
      await send(text);
      return;
    } catch (err) {
      attempt++;
      if (attempt >= opts.maxRetries) {
        throw err; // Exhausted retries
      }
      console.warn(
        `[poller] send attempt ${attempt} failed, retrying in ${backoff}ms: ` +
          errMessage(err),
      );
      await opts.sleep(backoff);
      // Exponential backoff with cap
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
  }
}

export function createPoller(deps: PollerDeps) {
  const { config, server, send } = deps;
  const readEvents = deps.readEvents ?? readContractEvents;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const sendSpacingMs = deps.sendSpacingMs ?? SEND_SPACING_MS;
  const maxSendRetries = deps.maxSendRetries ?? MAX_SEND_RETRIES;

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

  const deadLetter = createDeadLetterQueue({
    filePath: config.deadLetterFile,
    maxEntries: config.deadLetterMax,
    maxAttempts: config.deadLetterMaxAttempts,
    now,
  });

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
    deadLetter: deadLetter.stats(),
  };

  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let inFlight = false;

  function refreshDeadLetterStatus(): void {
    status.deadLetter = deadLetter.stats();
  }

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
      updatedAt: new Date(now()).toISOString(),
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

  // ── One cycle ──────────────────────────────────────────────────────────────

  async function notify(events: DecodedEvent[], sendBudget: number): Promise<number> {
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

      if (sentThisCycle >= sendBudget) {
        status.eventsSkipped += 1;
        console.warn(
          `[poller] cycle notification cap (${config.maxNotificationsPerCycle}) reached; ` +
            `dropping ${event.payload.name} at ledger ${event.ledger}`,
        );
        continue;
      }

      try {
        // Use bounded retry for Telegram sends to handle transient failures
        await sendWithRetry(send, text, { sleep, maxRetries: maxSendRetries });
        status.notificationsSent += 1;
        sentThisCycle += 1;
      } catch (err) {
        // All retries exhausted; park on the DLQ and keep processing.
        status.notificationsFailed += 1;
        console.error(
          `[poller] send failed for ${event.payload.name} at ledger ${event.ledger} after retries: ` +
            errMessage(err),
        );
        await deadLetter.enqueue({
          source: event.source,
          ledger: event.ledger,
          eventName: event.payload.name,
          text,
          error: err,
        });
        refreshDeadLetterStatus();
      }

      if (sentThisCycle < sendBudget && sendSpacingMs > 0) {
        await sleep(sendSpacingMs);
      }
    }

    return sentThisCycle;
  }

  async function cycle(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    status.cycles += 1;
    status.lastPollAt = now();

    let anyOk = false;
    let sentBudgetUsed = 0;

    // Replay parked sends before new events so a recovered chat drains first.
    try {
      const flushBudget = Math.max(0, config.maxNotificationsPerCycle);
      if (flushBudget > 0) {
        const flushed = await deadLetter.flush(
          async (text) => {
            await sendWithRetry(send, text, { sleep, maxRetries: maxSendRetries });
          },
          flushBudget,
        );
        if (flushed.sent > 0) {
          status.notificationsSent += flushed.sent;
          sentBudgetUsed += flushed.sent;
          if (sendSpacingMs > 0) await sleep(sendSpacingMs);
        }
        refreshDeadLetterStatus();
      }
    } catch (err) {
      // flush itself swallows send errors; this is belt-and-braces.
      console.error(`[poller] dead-letter flush threw: ${errMessage(err)}`);
    }

    for (const target of targets) {
      const current = state.get(target.source);
      if (!current) continue;

      try {
        const scan = await readEvents(server, target, {
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
          // Cap remaining new sends against what the DLQ already consumed.
          const remaining = Math.max(0, config.maxNotificationsPerCycle - sentBudgetUsed);
          if (remaining === 0) {
            for (const event of scan.events) {
              if (event.payload.name === "unknown" || formatEvent(config, event) === null) {
                status.eventsSkipped += 1;
                continue;
              }
              status.eventsSkipped += 1;
            }
            console.warn(
              `[poller] cycle notification cap already spent on dead-letter replay; ` +
                `skipping new events for ${target.source}`,
            );
          } else {
            const sent = await notify(scan.events, remaining);
            sentBudgetUsed += sent;
          }
        }

        if (scan.lastEventLedger !== null) current.lastEventLedger = scan.lastEventLedger;
        // Advance last — see the failure policy at the top of this file.
        if (scan.cursor) current.cursor = scan.cursor;
      } catch (err) {
        const message = errMessage(err);
        current.lastError = message;
        status.lastError = { at: now(), message: `${target.source}: ${message}` };
        console.error(`[poller] ${target.source} scan failed: ${message}`);
      }
    }

    if (anyOk) {
      status.lastSuccessAt = now();
      status.consecutiveFailures = 0;
    } else {
      status.consecutiveFailures += 1;
    }

    status.targets = [...state.values()].map((t) => ({ ...t }));
    refreshDeadLetterStatus();
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
      await deadLetter.load();
      refreshDeadLetterStatus();
      status.running = true;
      status.startedAt = now();
      status.targets = [...state.values()].map((t) => ({ ...t }));
      console.log(
        `[poller] watching market=${config.marketContractId} squad=${config.squadContractId} ` +
          `every ${config.pollIntervalMs}ms (dead-letter=${config.deadLetterFile}, ` +
          `max=${config.deadLetterMax})`,
      );
      void loop();
    },

    /** Run a single cycle — used by tests; production uses start()/loop(). */
    async pollOnce(): Promise<void> {
      if (!status.running) {
        await loadCursors();
        await deadLetter.load();
        refreshDeadLetterStatus();
        status.running = true;
        status.startedAt = now();
      }
      await cycle();
    },

    stop(): void {
      stopped = true;
      status.running = false;
      if (timer) clearTimeout(timer);
      timer = null;
    },

    status(): PollerStatus {
      refreshDeadLetterStatus();
      return {
        ...status,
        targets: [...state.values()].map((t) => ({ ...t })),
        deadLetter: deadLetter.stats(),
      };
    },
  };
}

export type Poller = ReturnType<typeof createPoller>;
