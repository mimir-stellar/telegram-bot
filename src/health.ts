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
import type { AddressInfo, Socket } from "node:net";

import {
  emptyActivityBaseline,
  type ActivityBaselineSnapshot,
} from "./activity-baseline.js";
import {
  configProvenance,
  DEFAULT_HEALTH_SHUTDOWN_GRACE_MS,
  networkLabel,
  type BotConfig,
  type ConfigProvenance,
} from "./config.js";
import type { LogCapture } from "./logger.js";
import type { DecodedEvent } from "./stellar/decode.js";
import { buildAtomFeed } from "./stellar/feed.js";
import { safeErrorMessage } from "./notifications/format.js";
import type { PollerStatus } from "./poller.js";
import { redactText } from "./redact.js";
import {
  RpcLatencyHistogram,
  renderRpcLatencySnapshotLines,
} from "./stellar/metrics.js";

export interface HealthDeps {
  config: BotConfig;
  status: () => PollerStatus;
  /** Bounded redacted log ring; when absent or disabled, /health/diag 404s. */
  logs?: LogCapture;
  /** Optional clock for deterministic tests. */
  now?: () => number;
  /** Optional handler for Telegram webhook mode (POST /telegram-webhook). */
  webhookHandler?: ((req: http.IncomingMessage, res: http.ServerResponse) => void) | undefined;
  /** Retained decoded events served by the opt-in read-only Atom route. */
  atomEvents?: (() => readonly DecodedEvent[]) | undefined;
  /**
   * Optional provenance reader for deterministic tests. Defaults to
   * {@link configProvenance}; either way only key names and origins are served.
   */
  provenance?: () => ConfigProvenance;
}

export interface HealthCloseOptions {
  /**
   * Milliseconds to wait for active or stalled client sockets to close during
   * shutdown before force-closing them. Defaults to `config.healthShutdownGraceMs`
   * (or {@link DEFAULT_HEALTH_SHUTDOWN_GRACE_MS}); `0` force-closes immediately.
   */
  gracePeriodMs?: number;
}

export interface HealthServer {
  /** Resolved listen URL, e.g. http://127.0.0.1:8787. Null when disabled. */
  url: string | null;
  /** Port actually bound (0 when disabled). */
  port: number;
  /**
   * Transition the server into shutdown drain mode before stopping polling.
   * Readiness probes immediately report not ready (HTTP 503) and operational
   * HTTP work stops being accepted, while liveness stays 200 until `close()`.
   * Idempotent.
   */
  beginShutdown(): void;
  /** Whether `beginShutdown()` has been called. */
  isShuttingDown(): boolean;
  close(): Promise<void>;
}

/** Optional overrides for {@link buildHealthReport}. */
export interface HealthReportOptions {
  /** True once shutdown readiness transition has started, before poller.stopping flips. */
  draining?: boolean;
}

/** Safe, redacted snapshot for HTTP clients. Never includes secrets. */
export interface HealthReport {
  ok: boolean;
  /**
   * Operational readiness: true only when `status === "ok"` and the process is
   * not draining for shutdown. Readiness probes return HTTP 200 iff `ready`.
   */
  ready: boolean;
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
   * Per-dependency readiness, separating *why* the bot is not ready into the
   * four dependencies it relies on: reaching the RPC, a usable cursor, a
   * configured route, and working delivery. Additive detail; the overall
   * {@link HealthReport.ok} / {@link HealthReport.status} are unchanged.
   */
  dependencies: HealthDependencies;
  /**
   * Where configuration came from: each setting's name and the source that
   * supplied it. No value — secret or not — is ever included, so an operator
   * can confirm *which* token and chat id this process is using without either
   * of them leaving the process.
   */
  config: ConfigProvenance;
}

/** Readiness of a single dependency the bot relies on to deliver notifications. */
export interface DependencyReadiness {
  /** True when this dependency is ready to serve. */
  ready: boolean;
  /**
   * Value-free reason this dependency is not ready, or `null` when ready.
   * Built only from counts and public source names (`market`/`squad`); never a
   * token, a chat id, or another private destination identifier.
   */
  reason: string | null;
}

/**
 * The four dependencies the notifier relies on, assessed separately so an
 * operator or probe can tell *which* one is the bottleneck rather than only
 * that the overall status is degraded.
 *
 * `rpc` and `cursor` mirror the signals behind {@link HealthReport.status}'s
 * `"degraded"` verdict (consecutive failures, a stale success, a stale or
 * stalled cursor). `route` and `delivery` are independent: a route is ready as
 * soon as a destination is configured for each watched contract, and delivery
 * is ready when no sends are parked in the dead-letter queue. None of the
 * reasons ever carries a credential or a private destination identifier.
 */
export interface HealthDependencies {
  /** Stellar RPC reachability: the chain reads this process depends on. */
  rpc: DependencyReadiness;
  /** Cursor / resume-position usability across watched targets. */
  cursor: DependencyReadiness;
  /**
   * Telegram route configuration: a destination is configured for each watched
   * contract. Reasons name the source (`market`/`squad`), never the chat id.
   */
  route: DependencyReadiness;
  /**
   * Telegram delivery: sends are landing. Not ready when sends are parked in
   * the dead-letter queue. Counts only; never message text or a destination.
   */
  delivery: DependencyReadiness;
}

const CURSOR_PREVIEW_LEN = 24;

/**
 * Maximum UTF-8 byte length of an Authorization header accepted by the health
 * server, including the `Bearer ` scheme prefix. Longer values are malformed.
 */
export const MAX_AUTH_HEADER_BYTES = 4096;

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
 * The header's UTF-8 byte length is bounded before parsing or comparison, so
 * oversized values take the same unauthorised path as other malformed headers.
 */
function isValidAuth(
  authHeader: string | undefined,
  expectedToken: string | null | undefined,
): boolean {
  // No token configured (null, or absent from a config built before #546):
  // the server is loopback-only, which config validation enforces.
  if (expectedToken === null || expectedToken === undefined) return true;
  if (authHeader === undefined) return false;
  if (Buffer.byteLength(authHeader, "utf8") > MAX_AUTH_HEADER_BYTES) return false;

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
 * Assess the four dependencies separately so a probe can tell *which* one is
 * the bottleneck, not just that the overall status is degraded.
 *
 * - `rpc` and `cursor` reuse the same signals that drive `status === "degraded"`
 *   (consecutive failures, a stale success, a stale or stalled cursor). They
 *   are suppressed during an intentional pause or drain, mirroring how the
 *   overall status stays `"ok"` for those states.
 * - `route` is config-derived and independent of poller state: a destination
 *   is configured for each watched contract. Reasons name the source
 *   (`market`/`squad`), never the chat id.
 * - `delivery` follows the dead-letter queue depth: a non-zero depth is a real
 *   backlog that persists across a pause or drain, so it is reported whenever
 *   the poller is running (only a stopped poller reports "poller not running").
 *
 * Every reason is built from counts and public source names only.
 */
function assessDependencies(
  config: BotConfig,
  poller: PollerStatus,
  nowMs: number,
): HealthDependencies {
  const stopped = !poller.running;
  // Paused and draining are intentional: like the overall status, they do not
  // make an *active-polling* dependency not-ready on their own.
  const intentional = poller.paused === true || poller.stopping === true;

  // --- RPC: chain reachability -------------------------------------------
  let rpc: DependencyReadiness;
  if (stopped) {
    rpc = { ready: false, reason: "poller not running" };
  } else if (intentional) {
    rpc = { ready: true, reason: null };
  } else {
    const failureBudget = Math.max(3, Math.ceil(60_000 / Math.max(config.pollIntervalMs, 1)));
    if (poller.circuitBreaker?.open === true) {
      rpc = {
        ready: false,
        reason: `circuit breaker open after ${poller.circuitBreaker.failureCount} consecutive RPC failures`,
      };
    } else if (poller.consecutiveFailures >= failureBudget) {
      rpc = {
        ready: false,
        reason: `consecutive failures (${poller.consecutiveFailures}) exceed budget (${failureBudget})`,
      };
    } else if (
      poller.lastSuccessAt !== null &&
      config.healthStaleMs > 0 &&
      nowMs - (poller.lastSuccessAt as number) > config.healthStaleMs
    ) {
      rpc = { ready: false, reason: `no successful poll within ${config.healthStaleMs} ms` };
    } else {
      rpc = { ready: true, reason: null };
    }
  }

  // --- Cursor: resume-position usability --------------------------------
  let cursor: DependencyReadiness;
  if (stopped) {
    cursor = { ready: false, reason: "poller not running" };
  } else if (intentional) {
    cursor = { ready: true, reason: null };
  } else {
    const staleSources: string[] = [];
    const stalledSources: string[] = [];
    for (const t of poller.targets) {
      if (t.cursorStale === true) staleSources.push(t.source);
      if (t.cursorStalled === true) stalledSources.push(t.source);
    }
    const parts: string[] = [];
    if (staleSources.length > 0) parts.push(`stale cursor on ${staleSources.join(", ")}`);
    if (stalledSources.length > 0) parts.push(`stalled cursor on ${stalledSources.join(", ")}`);
    cursor =
      parts.length > 0
        ? { ready: false, reason: parts.join("; ") }
        : { ready: true, reason: null };
  }

  // --- Route: a destination is configured for each watched contract -----
  // Config-derived and independent of poller state. The route exists as soon
  // as the process boots with a valid config; a missing destination is the
  // only failure mode and it names the source, never the chat id.
  const defaultChat = config.chatId || config.chatIds?.[0] || "";
  const routeMissing: string[] = [];
  for (const t of poller.targets) {
    const dest =
      t.source === "market"
        ? config.marketChatId || defaultChat
        : config.squadChatId || defaultChat;
    if (!dest) routeMissing.push(t.source);
  }
  const route: DependencyReadiness =
    routeMissing.length > 0
      ? { ready: false, reason: `no destination configured for ${routeMissing.join(", ")}` }
      : { ready: true, reason: null };

  // --- Delivery: Telegram sends are landing -----------------------------
  let delivery: DependencyReadiness;
  if (stopped) {
    delivery = { ready: false, reason: "poller not running" };
  } else {
    // A non-zero depth is a persistent backlog that survives a pause or drain,
    // so it is reported whenever the poller is running rather than suppressed.
    const depth = poller.deadLetter?.depth ?? 0;
    delivery =
      depth > 0
        ? { ready: false, reason: `${depth} send(s) awaiting replay in the dead-letter queue` }
        : { ready: true, reason: null };
  }

  return { rpc, cursor, route, delivery };
}

function evaluateHealthStatus(
  config: BotConfig,
  poller: PollerStatus,
  nowMs: number,
  options: HealthReportOptions = {},
): { status: HealthReport["status"]; ready: boolean } {
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

  const draining = options.draining === true || poller.stopping === true;
  const ready = status === "ok" && !draining;
  return { status, ready };
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
  options: HealthReportOptions = {},
): HealthReport {
  const uptimeMs = poller.startedAt > 0 ? Math.max(0, nowMs - poller.startedAt) : 0;
  // Tolerate a status snapshot that never learned about the chain clock (and
  // any non-finite value): the report must stay JSON-serialisable, never NaN.
  const chainClockAt =
    typeof poller.chainClockAt === "number" && Number.isFinite(poller.chainClockAt)
      ? poller.chainClockAt
      : null;

  const { status, ready } = evaluateHealthStatus(config, poller, nowMs, options);

  return {
    ok: status === "ok",
    ready,
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
      channelPreviewMode: config.channelPreviewMode === true,
      cycles: poller.cycles,
      lastCorrelationId: poller.lastCorrelationId ?? null,
      lastPollAt: iso(poller.lastPollAt),
      lastSuccessAt: iso(poller.lastSuccessAt),
      latestLedger: poller.latestLedger,
      oldestLedger: poller.oldestLedger,
      chainClockAt: iso(chainClockAt),
      chainClockSkewMs: chainClockAt === null ? null : nowMs - chainClockAt,
      notificationsSent: poller.notificationsSent,
      notificationsFailed: poller.notificationsFailed,
      eventsSkipped: poller.eventsSkipped,
      eventsDeduplicated: poller.eventsDeduplicated ?? 0,
      activity: poller.activityBaseline ?? emptyActivityBaseline(),
      notificationsDropped: poller.notificationsDropped ?? 0,
      cursorRewinds: poller.cursorRewinds ?? 0,
      deadLetter: {
        depth: poller.deadLetter?.depth ?? 0,
        enqueued: poller.deadLetter?.enqueued ?? 0,
        replayed: poller.deadLetter?.replayed ?? 0,
        dropped: poller.deadLetter?.dropped ?? 0,
      },
      consecutiveFailures: poller.consecutiveFailures,
      suppressedLogs: poller.suppressedLogs ?? 0,
      lastError: poller.lastError
        ? {
            at: new Date(poller.lastError.at).toISOString(),
            message: redactText(poller.lastError.message),
          }
        : null,
      restartGaps: poller.restartGaps ?? 0,
      lastRestartGap: poller.lastRestartGap
        ? {
            at: new Date(poller.lastRestartGap.at).toISOString(),
            source: poller.lastRestartGap.source,
            cursorLedger: poller.lastRestartGap.cursorLedger,
            oldestLedger: poller.lastRestartGap.oldestLedger,
            missedLedgers: poller.lastRestartGap.missedLedgers,
          }
        : null,
      pendingFlush: poller.pendingFlush === true,
      lastFlushAt: iso(poller.lastFlushAt ?? null),
      targets: poller.targets.map((t) => ({
        source: t.source,
        version: t.version ?? "v1",
        contractId: t.contractId,
        lastCycleMs: t.lastCycleMs ?? 0,
        maxCycleMs: t.maxCycleMs ?? 0,
        lastEventLedger: t.lastEventLedger,
        cursorPreview: previewCursor(t.cursor),
        gapLedgers: typeof t.gapLedgers === "number" ? t.gapLedgers : 0,
        cursorResetAt: iso(t.cursorResetAt ?? null),
        cursorUnreadable: t.cursorUnreadable === true,
        rewindFromLedger: typeof t.rewindFromLedger === "number" ? t.rewindFromLedger : null,
        cursorStale: t.cursorStale === true,
        cursorStalled: t.cursorStalled === true,
        cyclesWithoutAdvance: t.cyclesWithoutAdvance,
        hasError: t.lastError !== null,
      })),
      persistentVolumeAvailable: poller.persistentVolumeAvailable ?? true,
      persistentVolumeError: poller.persistentVolumeError ?? null,
    },
    dependencies: assessDependencies(config, poller, nowMs),
    config: provenance,
  };
}

/**
 * Render poller status as Prometheus metrics.
 */
export function buildMetricsReport(
  config: BotConfig,
  poller: PollerStatus,
  nowMs: number = Date.now(),
): string {
  const uptimeMs = poller.startedAt > 0 ? Math.max(0, nowMs - poller.startedAt) : 0;
  const network = networkLabel(config);
  const netLabels = formatMetricLabels({ network });
  const activity = poller.activityBaseline ?? emptyActivityBaseline();

  const lines: string[] = [
    `# HELP mimir_telegram_uptime_ms Uptime in milliseconds`,
    `# TYPE mimir_telegram_uptime_ms gauge`,
    `mimir_telegram_uptime_ms${netLabels} ${uptimeMs}`,
    ``,
    `# HELP mimir_telegram_poller_running Whether the poller is currently running (1) or stopped/paused (0)`,
    `# TYPE mimir_telegram_poller_running gauge`,
    `mimir_telegram_poller_running${netLabels} ${poller.running && !poller.paused ? 1 : 0}`,
    ``,
    `# HELP mimir_telegram_poller_cycles_total Total number of completed poll cycles`,
    `# TYPE mimir_telegram_poller_cycles_total counter`,
    `mimir_telegram_poller_cycles_total${netLabels} ${poller.cycles}`,
    ``,
    `# HELP mimir_telegram_notifications_sent_total Total number of Telegram messages successfully sent`,
    `# TYPE mimir_telegram_notifications_sent_total counter`,
    `mimir_telegram_notifications_sent_total${netLabels} ${poller.notificationsSent}`,
    ``,
    `# HELP mimir_telegram_notifications_failed_total Total number of Telegram messages that failed to send after retries`,
    `# TYPE mimir_telegram_notifications_failed_total counter`,
    `mimir_telegram_notifications_failed_total${netLabels} ${poller.notificationsFailed}`,
    ``,
    `# HELP mimir_telegram_events_skipped_total Total number of events skipped (unrecognized, unformatted, or rate-limited)`,
    `# TYPE mimir_telegram_events_skipped_total counter`,
    `mimir_telegram_events_skipped_total${netLabels} ${poller.eventsSkipped}`,
    ``,
    `# HELP mimir_telegram_consecutive_failures Current number of consecutive failed poll cycles`,
    `# TYPE mimir_telegram_consecutive_failures gauge`,
    `mimir_telegram_consecutive_failures${netLabels} ${poller.consecutiveFailures}`,
    ``,
    `# HELP mimir_telegram_activity_last_cycle_events Events observed in the most recent complete poll cycle`,
    `# TYPE mimir_telegram_activity_last_cycle_events gauge`,
    `mimir_telegram_activity_last_cycle_events${netLabels} ${activity.lastValue ?? 0}`,
    ``,
    `# HELP mimir_telegram_activity_baseline_events Mean events per cycle in the rolling baseline (0 while warming up)`,
    `# TYPE mimir_telegram_activity_baseline_events gauge`,
    `mimir_telegram_activity_baseline_events${netLabels} ${activity.baselineMean ?? 0}`,
    ``,
    `# HELP mimir_telegram_activity_deviation Z-score of the latest complete cycle against the rolling baseline (0 while warming up)`,
    `# TYPE mimir_telegram_activity_deviation gauge`,
    `mimir_telegram_activity_deviation${netLabels} ${activity.zScore ?? 0}`,
    ``,
    `# HELP mimir_telegram_activity_anomalies_total Complete cycles classified as a spike or drop against the rolling baseline`,
    `# TYPE mimir_telegram_activity_anomalies_total counter`,
    `mimir_telegram_activity_anomalies_total${netLabels} ${activity.anomalies}`,
  ];

  if (poller.latestLedger !== null) {
    lines.push(
      ``,
      `# HELP mimir_telegram_latest_ledger Highest ledger seen by the poller`,
      `# TYPE mimir_telegram_latest_ledger gauge`,
      `mimir_telegram_latest_ledger${netLabels} ${poller.latestLedger}`
    );
  }

  const targetsWithLedgers = poller.targets.filter((t) => t.lastEventLedger !== null);
  if (targetsWithLedgers.length > 0) {
    lines.push(
      ``,
      `# HELP mimir_telegram_target_last_event_ledger Highest ledger in which an event was processed for a target`,
      `# TYPE mimir_telegram_target_last_event_ledger gauge`,
    );
    for (const target of targetsWithLedgers) {
      const targetLabels = formatMetricLabels({
        network,
        source: String(target.source),
        contract: String(target.contractId),
      });
      lines.push(
        `mimir_telegram_target_last_event_ledger${targetLabels} ${target.lastEventLedger}`
      );
    }
  }

  lines.push(
    ``,
    ...renderRpcLatencySnapshotLines(
      poller.rpcLatency ?? new RpcLatencyHistogram().snapshot(),
      `mimir_telegram_rpc_request_latency_ms`,
      `RPC latency in milliseconds across fixed buckets by operation`,
      { network },
    ),
  );

  return lines.join("\\n") + "\\n";
}

function sendHead(
  res: http.ServerResponse,
  statusCode: number,
  contentType = "application/json; charset=utf-8",
  closing = false,
): void {
  res.writeHead(statusCode, {
    "content-type": contentType,
    "cache-control": "no-store",
    ...(closing ? { connection: "close" } : {}),
  });
  res.end();
}

function sendJson(
  res: http.ServerResponse,
  statusCode: number,
  body: unknown,
  closing = false,
): void {
  const payload = `${JSON.stringify(body)}\n`;
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
    ...(closing ? { connection: "close" } : {}),
  });
  res.end(payload);
}

const HEALTH_GET_ROUTES = new Set([
  "/",
  "/health",
  "/healthz",
  "/health/live",
  "/livez",
  "/metrics",
]);

function sendMethodNotAllowed(res: http.ServerResponse, allow: string): void {
  const payload = `${JSON.stringify({ ok: false, error: "method_not_allowed" })}\n`;
  res.writeHead(405, {
    "allow": allow,
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendUnauthorized(res: http.ServerResponse): void {
  res.writeHead(401, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": "0",
    ...(closing ? { connection: "close" } : {}),
  });
  res.end();
}

function resolveShutdownGraceMs(overrideMs: number | undefined, configMs: number | undefined): number {
  if (typeof overrideMs === "number" && Number.isFinite(overrideMs)) {
    return Math.max(0, Math.trunc(overrideMs));
  }
  if (typeof configMs === "number" && Number.isFinite(configMs)) {
    return Math.max(0, Math.trunc(configMs));
  }
  return DEFAULT_HEALTH_SHUTDOWN_GRACE_MS;
}

/**
 * Start the local health HTTP server.
 *
 * `HEALTH_PORT=0` (or a resolved port of 0) disables the listener entirely —
 * useful for unit tests and one-shot CLI runs that must not bind a port.
 */
export function startHealthServer(deps: HealthDeps): HealthServer {
  const { config, status, logs, webhookHandler } = deps;
  const now = deps.now ?? Date.now;
  const provenance = deps.provenance ?? configProvenance;
  let draining = false;

  const beginShutdown = (): void => {
    draining = true;
  };
  const isShuttingDown = (): boolean => draining;

  if (config.healthPort === 0) {
    console.log("[health] disabled (HEALTH_PORT=0)");
    return {
      url: null,
      port: 0,
      beginShutdown,
      isShuttingDown,
      close: async () => undefined,
    };
  }

  const sockets = new Set<Socket>();
  let closing = false;
  let closePromise: Promise<void> | null = null;

  const server = http.createServer((req, res) => {
    if (closing) {
      res.setHeader("Connection", "close");
    }

    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://${config.healthHost}`);

    // Webhook deliveries carry Telegram's own secret-token header rather than
    // the health bearer token, and stop being accepted as soon as drain starts.
    if (webhookHandler && method === "POST" && url.pathname === "/telegram-webhook") {
      if (draining || status().stopping === true) {
        sendJson(res, 503, { ok: false, ready: false, error: "shutting_down" });
        return;
      }
      webhookHandler(req, res);
      return;
    }

    // Check authentication for all routes when token is configured
    if (!isValidAuth(req.headers.authorization, config.healthAuthToken)) {
      sendUnauthorized(res, closing);
      return;
    }

    if (HEALTH_GET_ROUTES.has(url.pathname) && method !== "GET" && method !== "HEAD") {
      sendMethodNotAllowed(res, "GET, HEAD");
      return;
    }

    if ((method === "GET" || method === "HEAD") && (url.pathname === "/health" || url.pathname === "/healthz")) {
      if (method === "HEAD") {
        const { ready } = evaluateHealthStatus(config, status(), now(), { draining });
        sendHead(res, ready ? 200 : 503, "application/json; charset=utf-8", closing);
        return;
      }
      const report = buildHealthReport(config, status(), now(), provenance(), { draining });
      sendJson(res, report.ready ? 200 : 503, report, closing);
      return;
    }

    if ((method === "GET" || method === "HEAD") && (url.pathname === "/health/live" || url.pathname === "/livez")) {
      // Liveness: the process is up and the HTTP server can answer. Do not
      // reflect poller degradation here — supervisors use /health for that.
      if (method === "HEAD") {
        sendHead(res, 200, "application/json; charset=utf-8", closing);
        return;
      }
      sendJson(
        res,
        200,
        {
          ok: true,
          status: "live",
          service: "mimir-telegram-bot",
          version: config.version,
          checkedAt: new Date(now()).toISOString(),
        },
        closing,
      );
      return;
    }

    if ((method === "GET" || method === "HEAD") && url.pathname === "/metrics") {
      if (method === "HEAD") {
        sendHead(res, 200, "text/plain; version=0.0.4; charset=utf-8", closing);
        return;
      }
      const metrics = buildMetricsReport(config, status(), now());
      res.writeHead(200, {
        "content-type": "text/plain; version=0.0.4; charset=utf-8",
        "cache-control": "no-store",
        "content-length": Buffer.byteLength(metrics),
        ...(closing ? { connection: "close" } : {}),
      });
      res.end(metrics);
      return;
    }

    if (config.atomFeedEnabled && url.pathname === "/atom") {
      if (method !== "GET") {
        res.writeHead(405, {
          allow: "GET",
          "cache-control": "no-store",
          "content-length": "0",
        });
        res.end();
        return;
      }
      const cap = config.atomFeedMaxEntries > 0 ? config.atomFeedMaxEntries : 50;
      const retained = deps.atomEvents?.() ?? [];
      const events = retained.slice(-cap);
      const selfUrl =
        config.atomFeedSelfUrl ?? `http://${config.healthHost}:${config.healthPort}/atom`;
      const xml = buildAtomFeed(events, {
        title: `Mimir Events (${networkLabel(config)})`,
        selfUrl,
        config,
      });
      res.writeHead(200, {
        "content-type": "application/atom+xml; charset=utf-8",
        "cache-control": "no-store",
        "content-length": Buffer.byteLength(xml),
      });
      res.end(xml);
      return;
    }

    if (method === "GET" && url.pathname === "/") {
      sendJson(res, 200, {
        service: "mimir-telegram-bot",
        health: "/health",
        live: "/health/live",
        metrics: "/metrics",
        ...(config.atomFeedEnabled ? { atom: "/atom" } : {}),
      });
      return;
    }

    if (method === "HEAD") {
      sendHead(res, 404, "application/json; charset=utf-8", closing);
      return;
    }

    sendJson(res, 404, { ok: false, error: "not_found" }, closing);
  });

  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
    });
  });

  // Failures after listen (e.g. client aborts) must not take down the notifier.
  server.on("error", (err) => {
    console.error(`[health] server error: ${safeErrorMessage(err)}`);
  });

  server.listen(config.healthPort, config.healthHost);

  const address = server.address() as AddressInfo | null;
  const port = address?.port ?? config.healthPort;
  const url = `http://${config.healthHost}:${port}`;
  console.log(
    `[health] listening on ${url} (GET /health, GET /health/live` +
      `${config.atomFeedEnabled ? ", GET /atom" : ""}` +
      `${logs && logs.capacity() > 0 ? ", GET /health/diag" : ""})`,
  );

  const forceDestroySockets = (): void => {
    server.closeAllConnections?.();
    for (const socket of sockets) {
      if (!socket.destroyed) socket.destroy();
    }
  };

  return {
    url,
    port,
    beginShutdown,
    isShuttingDown,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
