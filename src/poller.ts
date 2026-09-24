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
 *
 * Every bounded, interesting outcome on these paths is recorded to the operator
 * audit trail (src/audit.ts): scan failures and recoveries, send failures,
 * skipped and cap-dropped events, cursor loads, persist failures and stale-
 * cursor recoveries. The audit log never throws into the loop.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { rpc } from "@stellar/stellar-sdk";

import type { BotConfig } from "./config.js";
import { formatEvent } from "./notifications/format.js";
import { readContractEvents, eventCursorLedger, type WatchTarget } from "./stellar/events.js";
import type { ContractSource, DecodedEvent } from "./stellar/decode.js";
import { appendAuditFile, auditEntry, createAuditLog, type AuditLog } from "./audit.js";

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
  /**
   * Operator audit trail. A fresh one is created when omitted, so the poller
   * keeps working in callers that do not care about auditing (tests, tooling).
   */
  audit?: AuditLog | undefined;
  /**
   * Append flushed audit entries to `config.auditFile` each cycle. Enabled by
   * default; disable for in-memory-only auditing (ephemeral tooling, tests).
   */
  persistAudit?: boolean | undefined;
}

/** Telegram tolerates ~20 messages/minute to one chat; stay under it. */
const SEND_SPACING_MS = 1_500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createPoller(deps: PollerDeps) {
  const { config, server, send } = deps;
  const audit: AuditLog = deps.audit ?? createAuditLog();

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
      audit.record(
        auditEntry("cursor_loaded", {
          detail: [...state.values()].map((t) => `${t.source}@${t.cursor ?? "none"}`).join(" "),
        }),
      );
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
      audit.recordError(err, "cursor_persist_failed");
    }
    await flushAudit();
  }

  /**
   * Append buffered audit entries to the JSONL audit trail. Failure to audit
   * must never take the loop down (or even warn every cycle if the disk is
   * wedged): log once, drop the batch, keep running.
   */
  async function flushAudit(): Promise<void> {
    const pending = audit.flush();
    if (!deps.persistAudit || pending.length === 0) return;
    try {
      await appendAuditFile(config.auditFile, pending);
    } catch (err) {
      console.error(`[poller] could not append audit log: ${errMessage(err)}`);
    }
  }

  // ── One cycle ──────────────────────────────────────────────────────────────

  async function notify(events: DecodedEvent[]): Promise<void> {
    let sentThisCycle = 0;

    for (const event of events) {
      if (event.payload.name === "unknown") {
        status.eventsSkipped += 1;
        audit.record(
          auditEntry("event_skipped", {
            source: event.source,
            detail:
              `${event.payload.eventName} at ledger ${event.ledger}` +
              (event.payload.reason ? `: ${event.payload.reason}` : ""),
          }),
        );
        console.log(
          `[poller] skipped ${event.source} event "${event.payload.eventName}" ` +
            `at ledger ${event.ledger}${event.payload.reason ? ` (${event.payload.reason})` : ""}`,
        );
        continue;
      }

      const text = formatEvent(config, event);
      if (text === null) {
        status.eventsSkipped += 1;
        audit.record(
          auditEntry("event_skipped", {
            source: event.source,
            detail: `${event.payload.name} at ledger ${event.ledger}: notifiable text was null`,
          }),
        );
        continue;
      }

      if (sentThisCycle >= config.maxNotificationsPerCycle) {
        status.eventsSkipped += 1;
        audit.record(
          auditEntry("cap_reached", {
            source: event.source,
            detail:
              `${event.payload.name} at ledger ${event.ledger} dropped; ` +
              `cap is ${config.maxNotificationsPerCycle} per cycle`,
          }),
        );
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
        audit.recordError(err, "send_failed", {
          source: event.source,
          detail: `${event.payload.name} at ledger ${event.ledger}`,
        });
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
      const previousFailed = current.lastError !== null;

      try {
        const scan = await readContractEvents(server, target, {
          cursor: current.cursor ?? undefined,
          lookbackLedgers: current.cursor ? undefined : config.startLookbackLedgers,
        });

        status.latestLedger = scan.latestLedger;
        status.oldestLedger = scan.oldestLedger;
        current.lastError = null;
        anyOk = true;

        if (previousFailed) {
          audit.record(
            auditEntry("cycle_recovered", {
              source: target.source,
              detail: `scan ok after failure; cursor ${current.cursor ?? "none"}`,
            }),
          );
        }

        if (
          current.cursor !== null &&
          scan.oldestLedger > 0 &&
          eventCursorLedger(current.cursor) !== null &&
          eventCursorLedger(current.cursor)! < scan.oldestLedger
        ) {
          // The RPC has aged out the segment the cursor points at. Continuing
          // from it is undefined behaviour on the wire — the safe, non-duplicating
          // recovery is a fresh cold start at the retained floor. The gap stays
          // visible in /status and the audit trail; the chain remains the record.
          audit.record(
            auditEntry("stale_cursor", {
              source: target.source,
              detail:
                `cursor ledger ${eventCursorLedger(current.cursor)} is below the RPC's ` +
                `retained floor ${scan.oldestLedger}; restarting from the floor. ` +
                `Events in between are gone from the RPC window`,
            }),
          );
          console.warn(
            `[poller] ${target.source}: stored cursor is below the RPC's retained ` +
              `floor (${scan.oldestLedger}); restarting from the floor`,
          );
          current.cursor = null;
          current.lastEventLedger = null;
        }

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
        audit.recordError(err, "cycle_failed", { source: target.source });
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
      audit.recordError(err, "cycle_failed");
      await flushAudit();
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
      status.startedAt = Date.now();
      status.targets = [...state.values()].map((t) => ({ ...t }));
      console.log(
        `[poller] watching market=${config.marketContractId} squad=${config.squadContractId} ` +
          `every ${config.pollIntervalMs}ms`,
      );
      await flushAudit();
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

    audit,

    /** Persist buffered audit entries now (used on shutdown). */
    flushAuditFile(): Promise<void> {
      return flushAudit();
    },
  };
}

export type Poller = ReturnType<typeof createPoller>;
