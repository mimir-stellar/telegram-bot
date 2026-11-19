/**
 * Local HTTP health endpoint for process supervisors and deploy checks.
 *
 * Bound to loopback by default so it is never an accidental public surface.
 * Responses are JSON-only operational status: no bot tokens, private keys,
 * chat ids, or raw remote payloads. The `config` section names each setting and
 * the source that supplied it — the one thing about configuration that is safe
 * to publish is where it came from.
 */

import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

import {
  emptyActivityBaseline,
  type ActivityBaselineSnapshot,
} from "./activity-baseline.js";
import { configProvenance, networkLabel, type BotConfig, type ConfigProvenance } from "./config.js";
import type { LogCapture } from "./logger.js";
import { safeErrorMessage } from "./notifications/format.js";
import type { PollerStatus } from "./poller.js";
import { redactText } from "./redact.js";

export interface HealthDeps {
  config: BotConfig;
  status: () => PollerStatus;
  /** Bounded redacted log ring; when absent or disabled, /health/diag 404s. */
  logs?: LogCapture;
  /** Optional clock for deterministic tests. */
  now?: () => number;
  /** Optional handler for Telegram webhook mode (POST /telegram-webhook). */
  webhookHandler?: ((req: http.IncomingMessage, res: http.ServerResponse) => void) | undefined;
  /**
   * Optional provenance reader for deterministic tests. Defaults to
   * {@link configProvenance}; either way only key names and origins are served.
   */
  provenance?: () => ConfigProvenance;
}

export interface HealthServer {
  /** Resolved listen URL, e.g. http://127.0.0.1:8787. Null when disabled. */
  url: string | null;
  /** Port actually bound (0 when disabled). */
  port: number;
  close(): Promise<void>;
}

/** Safe, redacted snapshot for HTTP clients. Never includes secrets. */
export interface HealthReport {
  ok: boolean;
  status: "ok" | "degraded" | "stopped";
  service: "mimir-telegram-bot";
  /** Semver string from `package.json`, or `"unknown"` if unavailable. */
  version: string;
  network: string;
  uptimeMs: number;
  checkedAt: string;
  poller: {
    running: boolean;
    /** Intentional operator pause; process is ready but scheduling is stopped. */
    paused: boolean;
    /** A graceful shutdown is draining: no new cycles, unsent messages dropped. */
    stopping: boolean;
    channelPreviewMode: boolean;
    cycles: number;
    /** Correlation ID for the most recently started poll cycle. */
    lastCorrelationId: string | null;
    lastPollAt: string | null;
    lastSuccessAt: string | null;
    latestLedger: number | null;
    oldestLedger: number | null;
    /** Newest observed chain close time (ISO 8601); null until one is seen. */
    chainClockAt: string | null;
    /**
     * Chain clock skew in ms: `checkedAt - chainClockAt`. Positive while the
     * bot's clock is ahead of the newest chain time it has seen, negative when
     * it is behind, null when no chain time has been observed yet (cold start,
     * or a run of scans that returned no events).
     */
    chainClockSkewMs: number | null;
    notificationsSent: number;
    notificationsFailed: number;
    eventsSkipped: number;
    /** Events suppressed as already-seen across overlapping pages / resumes. */
    eventsDeduplicated: number;
    /**
     * Rolling comparison of the latest complete cycle's event count with the
     * recent baseline. A spike is not a fault by itself; it is context for the
     * counters and the per-cycle log lines.
     */
    activity: ActivityBaselineSnapshot;
    notificationsDropped: number;
    /** Cursors automatically rewound to the RPC's retained floor this run. */
    cursorRewinds: number;
    /**
     * Bounded queue of sends that exhausted their retries and are waiting to
     * be replayed. Counts only: no message text, no destination.
     */
    deadLetter: { depth: number; enqueued: number; replayed: number; dropped: number };
    consecutiveFailures: number;
    /** Repetitive error lines summarized rather than printed since start. */
    suppressedLogs: number;
    lastError: { at: string; message: string } | null;
    /** Restart gaps detected since this process started. */
    restartGaps: number;
    /**
     * The most recent resume position that fell below the RPC's retained
     * window. The events it skipped are unrecoverable; this is what made them
     * visible. Ledger numbers only — never a token or a remote payload.
     */
    lastRestartGap: {
      at: string;
      source: string;
      cursorLedger: number;
      oldestLedger: number;
      missedLedgers: number;
    } | null;
    /**
     * In-memory cursor state that is not on disk yet. False after a successful
     * flush, which is what a shutdown is for.
     */
    pendingFlush: boolean;
    lastFlushAt: string | null;
    targets: Array<{
      source: string;
      version: string;
      /** Public contract id (on-chain). */
      contractId: string;
      /** Duration of this target's most recent attempted cycle. */
      lastCycleMs: number;
      /** Longest attempted cycle for this target since process start. */
      maxCycleMs: number;
      lastEventLedger: number | null;
      /** Opaque resume cursor; not a secret. Truncated for readability. */
      cursorPreview: string | null;
      /** Ledgers lost to the retained window at this target's last restart gap. */
      gapLedgers: number;
      /** When this target's stale cursor was last rewound, or null. */
      cursorResetAt: string | null;
      /** A cursor is persisted but no ledger can be read out of it. */
      cursorUnreadable: boolean;
      /** Ledger a target is resuming from after a floor rewind, or null. */
      rewindFromLedger: number | null;
      /** RPC rejected this target's cursor as stale; true until a scan succeeds. */
      cursorStale: boolean;
      /** Successful cycles with an unchanged cursor while behind the tip. */
      cyclesWithoutAdvance: number;
      /** Cursor unchanged for {@link CURSOR_STALL_CYCLES} cycles while behind tip. */
      cursorStalled: boolean;
      hasError: boolean;
    }>;
    persistentVolumeAvailable: boolean;
    persistentVolumeError: string | null;
  };
  /**
   * Where configuration came from: each setting's name and the source that
   * supplied it. No value — secret or not — is ever included, so an operator
   * can confirm *which* token and chat id this process is using without either
   * of them leaving the process.
   */
  config: ConfigProvenance;
}

const CURSOR_PREVIEW_LEN = 24;

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

/**
 * Constant-time comparison for bearer token authentication.
 * Prevents timing attacks that could reveal the token.
 */
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Extract and validate the bearer token from the Authorization header.
 * Returns true if the token matches the expected value (or if auth is disabled).
 */
function isValidAuth(
  authHeader: string | undefined,
  expectedToken: string | null | undefined,
): boolean {
  // No token configured (null, or absent from a config built before #546):
  // the server is loopback-only, which config validation enforces.
  if (expectedToken === null || expectedToken === undefined) return true;
  if (authHeader === undefined) return false;

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match || match[1] === undefined) return false;

  const providedToken = match[1];
  return constantTimeEquals(providedToken, expectedToken);
}

function previewCursor(cursor: string | null): string | null {
  if (cursor === null) return null;
  if (cursor.length <= CURSOR_PREVIEW_LEN) return cursor;
  return `${cursor.slice(0, CURSOR_PREVIEW_LEN)}…`;
}

/** Bounded human duration for a skew: s, m, h, d, then years. */
function formatSkew(absMs: number): string {
  const dayMs = 86_400_000;
  if (absMs < 60_000) return `${(absMs / 1000).toFixed(1)}s`;
  if (absMs < 3_600_000) return `${Math.round(absMs / 60_000)}m`;
  if (absMs < 3_600_000 * 24) return `${Math.round(absMs / 3_600_000)}h`;
  if (absMs < dayMs * 365) return `${Math.round(absMs / dayMs)}d`;
  return `${Math.round(absMs / (dayMs * 365))}y`;
}

/**
 * Human rendering of the chain clock skew, shared by `/status` and `/health`.
 *
 * `chainClockAt` is the newest chain close time the poller observed; the skew
 * is `nowMs - chainClockAt`. The wording always names the side that is ahead,
 * because a bare "+3s" or "behind" is ambiguous about which clock is wrong.
 *
 * Returns plain text (no Markdown): pass it through `escapeMd` before putting
 * it in a Telegram message. `unknown` before the first observation, `in sync`
 * inside one second, otherwise a bounded `s`/`m`/`h`/`d`/`y` duration.
 */
export function chainClockLabel(chainClockAt: number | null | undefined, nowMs: number): string {
  if (typeof chainClockAt !== "number" || !Number.isFinite(chainClockAt)) return "unknown";
  const skewMs = nowMs - chainClockAt;
  const abs = Math.abs(skewMs);
  if (abs < 1_000) return "in sync";
  const human = formatSkew(abs);
  return skewMs >= 0
    ? `local clock ${human} ahead of chain`
    : `chain clock ${human} ahead of local`;
}

/**
 * Build a health report from poller status.
 *
 * - `ok` / HTTP 200 when the poller is running and has not exceeded the
 *   consecutive-failure budget (and, once it has succeeded at least once,
 *   a successful poll happened within `healthStaleMs`).
 * - `degraded` / HTTP 503 when running but stale or failing repeatedly.
 * - `stopped` / HTTP 503 when the poller is not running.
 */
export function buildHealthReport(
  config: BotConfig,
  poller: PollerStatus,
  nowMs: number = Date.now(),
  provenance: ConfigProvenance = configProvenance(),
): HealthReport {
  const uptimeMs = poller.startedAt > 0 ? Math.max(0, nowMs - poller.startedAt) : 0;
  // Tolerate a status snapshot that never learned about the chain clock (and
  // any non-finite value): the report must stay JSON-serialisable, never NaN.
  const chainClockAt =
    typeof poller.chainClockAt === "number" && Number.isFinite(poller.chainClockAt)
      ? poller.chainClockAt
      : null;

  let status: HealthReport["status"];
  if (!poller.running) {
    status = "stopped";
  } else if (poller.stopping === true) {
    // A deliberate drain is doing exactly what it was asked to do. It is not a
    // stale or failing poller, and `poller.stopping` is how clients tell the
    // difference from an operator pause.
    status = "ok";
  } else if (poller.paused) {
    // A deliberate operator pause is healthy, not a stale or failing poller.
    status = "ok";
  } else {
    const failureBudget = Math.max(3, Math.ceil(60_000 / Math.max(config.pollIntervalMs, 1)));
    const tooManyFailures = poller.consecutiveFailures >= failureBudget;
    const hasStaleCursor = poller.targets.some((target) => target.cursorStale === true);
    // A stalled cursor is a live fault the failure counters cannot see: every
    // cycle succeeds, it just never makes progress.
    const hasStalledCursor = poller.targets.some((target) => target.cursorStalled === true);
    const hasEverSucceeded = poller.lastSuccessAt !== null;
    const stale =
      hasEverSucceeded &&
      config.healthStaleMs > 0 &&
      nowMs - (poller.lastSuccessAt as number) > config.healthStaleMs;
    status = tooManyFailures || stale || hasStaleCursor || hasStalledCursor ? "degraded" : "ok";
  }

  return {
    ok: status === "ok",
    status,
    service: "mimir-telegram-bot",
    version: config.version,
    network: networkLabel(config),
    uptimeMs,
    checkedAt: new Date(nowMs).toISOString(),
    poller: {
      running: poller.running,
      paused: poller.paused === true,
      stopping: poller.stopping === true,
    },
    config: provenance,
  };
}
