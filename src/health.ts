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
import { readFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";

import {
  emptyActivityBaseline,
  type ActivityBaselineSnapshot,
} from "./activity-baseline.js";
import {
  APP_VERSION,
  configProvenance,
  networkLabel,
  resolveStatusFile,
  type BotConfig,
  type ConfigProvenance,
} from "./config.js";
import type { LogCapture } from "./logger.js";
import { safeErrorMessage } from "./notifications/format.js";
import type { PollerStatus } from "./poller.js";
import { redactText, redactUrl } from "./redact.js";
import {
  STATUS_SCHEMA_VERSION,
  boundText,
  redactChatId,
  type StatusSnapshot,
} from "./status.js";

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
  const activity = poller.activityBaseline ?? emptyActivityBaseline();

  const lines: string[] = [
    `# HELP mimir_telegram_uptime_ms Uptime in milliseconds`,
    `# TYPE mimir_telegram_uptime_ms gauge`,
    `mimir_telegram_uptime_ms{network="${network}"} ${uptimeMs}`,
    ``,
    `# HELP mimir_telegram_poller_running Whether the poller is currently running (1) or stopped/paused (0)`,
    `# TYPE mimir_telegram_poller_running gauge`,
    `mimir_telegram_poller_running{network="${network}"} ${poller.running && !poller.paused ? 1 : 0}`,
    ``,
    `# HELP mimir_telegram_poller_cycles_total Total number of completed poll cycles`,
    `# TYPE mimir_telegram_poller_cycles_total counter`,
    `mimir_telegram_poller_cycles_total{network="${network}"} ${poller.cycles}`,
    ``,
    `# HELP mimir_telegram_notifications_sent_total Total number of Telegram messages successfully sent`,
    `# TYPE mimir_telegram_notifications_sent_total counter`,
    `mimir_telegram_notifications_sent_total{network="${network}"} ${poller.notificationsSent}`,
    ``,
    `# HELP mimir_telegram_notifications_failed_total Total number of Telegram messages that failed to send after retries`,
    `# TYPE mimir_telegram_notifications_failed_total counter`,
    `mimir_telegram_notifications_failed_total{network="${network}"} ${poller.notificationsFailed}`,
    ``,
    `# HELP mimir_telegram_events_skipped_total Total number of events skipped (unrecognized, unformatted, or rate-limited)`,
    `# TYPE mimir_telegram_events_skipped_total counter`,
    `mimir_telegram_events_skipped_total{network="${network}"} ${poller.eventsSkipped}`,
    ``,
    `# HELP mimir_telegram_consecutive_failures Current number of consecutive failed poll cycles`,
    `# TYPE mimir_telegram_consecutive_failures gauge`,
    `mimir_telegram_consecutive_failures{network="${network}"} ${poller.consecutiveFailures}`,
    ``,
    `# HELP mimir_telegram_activity_last_cycle_events Events observed in the most recent complete poll cycle`,
    `# TYPE mimir_telegram_activity_last_cycle_events gauge`,
    `mimir_telegram_activity_last_cycle_events{network="${network}"} ${activity.lastValue ?? 0}`,
    ``,
    `# HELP mimir_telegram_activity_baseline_events Mean events per cycle in the rolling baseline (0 while warming up)`,
    `# TYPE mimir_telegram_activity_baseline_events gauge`,
    `mimir_telegram_activity_baseline_events{network="${network}"} ${activity.baselineMean ?? 0}`,
    ``,
    `# HELP mimir_telegram_activity_deviation Z-score of the latest complete cycle against the rolling baseline (0 while warming up)`,
    `# TYPE mimir_telegram_activity_deviation gauge`,
    `mimir_telegram_activity_deviation{network="${network}"} ${activity.zScore ?? 0}`,
    ``,
    `# HELP mimir_telegram_activity_anomalies_total Complete cycles classified as a spike or drop against the rolling baseline`,
    `# TYPE mimir_telegram_activity_anomalies_total counter`,
    `mimir_telegram_activity_anomalies_total{network="${network}"} ${activity.anomalies}`,
  ];

  if (poller.latestLedger !== null) {
    lines.push(
      ``,
      `# HELP mimir_telegram_latest_ledger Highest ledger seen by the poller`,
      `# TYPE mimir_telegram_latest_ledger gauge`,
      `mimir_telegram_latest_ledger{network="${network}"} ${poller.latestLedger}`
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
      lines.push(
        `mimir_telegram_target_last_event_ledger{network="${network}",source="${target.source}",contract="${target.contractId}"} ${target.lastEventLedger}`
      );
    }
  }

  return lines.join("\\n") + "\\n";
}

function sendJson(
  res: http.ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  const payload = `${JSON.stringify(body)}\n`;
  res.writeHead(statusCode, {
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
  });
  res.end();
}

/**
 * Start the local health HTTP server.
 *
 * `HEALTH_PORT=0` (or a resolved port of 0) disables the listener entirely —
 * useful for unit tests and one-shot CLI runs that must not bind a port.
 */
export function startHealthServer(deps: HealthDeps): HealthServer {
  const { config, status, logs } = deps;
  const now = deps.now ?? Date.now;
  const provenance = deps.provenance ?? configProvenance;

  if (config.healthPort === 0) {
    console.log("[health] disabled (HEALTH_PORT=0)");
    return { url: null, port: 0, close: async () => undefined };
  }

  const server = http.createServer((req, res) => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://${config.healthHost}`);

    // Check authentication for all routes when token is configured
    if (!isValidAuth(req.headers.authorization, config.healthAuthToken)) {
      sendUnauthorized(res);
      return;
    }

    if (method === "GET" && (url.pathname === "/health" || url.pathname === "/healthz")) {
      const report = buildHealthReport(config, status(), now(), provenance());
      sendJson(res, report.ok ? 200 : 503, report);
      return;
    }

    if (method === "GET" && (url.pathname === "/health/live" || url.pathname === "/livez")) {
      // Liveness: the process is up and the HTTP server can answer. Do not
      // reflect poller degradation here — supervisors use /health for that.
      sendJson(res, 200, {
        ok: true,
        status: "live",
        service: "mimir-telegram-bot",
        version: config.version,
        checkedAt: new Date(now()).toISOString(),
      });
      return;
    }

    if (method === "GET" && url.pathname === "/metrics") {
      const metrics = buildMetricsReport(config, status(), now());
      res.writeHead(200, {
        "content-type": "text/plain; version=0.0.4; charset=utf-8",
        "cache-control": "no-store",
        "content-length": Buffer.byteLength(metrics),
      });
      res.end(metrics);
      return;
    }

    if (method === "GET" && url.pathname === "/") {
      sendJson(res, 200, {
        service: "mimir-telegram-bot",
        health: "/health",
        live: "/health/live",
        metrics: "/metrics",
      });
      return;
    }

    sendJson(res, 404, { ok: false, error: "not_found" });
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
      `${logs && logs.capacity() > 0 ? ", GET /health/diag" : ""})`,
  );

  return {
    url,
    port,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

export type OfflineHealthState =
  | "ok"
  | "degraded"
  | "stopped"
  | "stale"
  | "malformed"
  | "missing";

export interface OfflineHealthOptions {
  /** Max allowed age (ms) for snapshot / last successful poll (`0` disables staleness checks). */
  staleMs?: number;
  /** Deterministic reference clock in unix milliseconds (defaults to `Date.now()`). */
  nowMs?: number;
}

export interface OfflineHealthReport {
  ok: boolean;
  status: OfflineHealthState;
  mode: "offline";
  service: "mimir-telegram-bot";
  version: string;
  file: string;
  checkedAt: string;
  staleThresholdMs: number;
  problems: string[];
  snapshot: {
    schemaVersion: number;
    generatedAt: string;
    ageMs: number;
    stale: boolean;
    running: boolean;
    network: string;
    rpcUrl: string;
    chatId: string;
    pollIntervalMs: number;
    uptimeMs: number | null;
    cycles: number;
    lastPollAt: string | null;
    lastSuccessAt: string | null;
    lastSuccessAgeMs: number | null;
    latestLedger: number | null;
    oldestLedger: number | null;
    notificationsSent: number;
    notificationsFailed: number;
    eventsSkipped: number;
    eventsDeduplicated: number;
    cursorRewinds: number;
    consecutiveFailures: number;
    sendTimeouts: number;
    lastError: { at: string; message: string } | null;
    targets: Array<{
      source: string;
      contractId: string;
      lastCycleMs: number;
      maxCycleMs: number;
      cursorPreview: string | null;
      lastEventLedger: number | null;
      rewindFromLedger: number | null;
      cursorStale: boolean;
      hasError: boolean;
      lastError: string | null;
    }>;
  } | null;
}

const DEFAULT_OFFLINE_STALE_MS = 90_000;

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isNullableNonNegativeInt(value: unknown): value is number | null {
  return value === null || isNonNegativeInt(value);
}

function resolveOfflineStaleMs(
  explicitStaleMs: number | undefined,
  pollIntervalMs?: number,
): number {
  if (
    typeof explicitStaleMs === "number" &&
    Number.isFinite(explicitStaleMs) &&
    explicitStaleMs >= 0
  ) {
    return Math.floor(explicitStaleMs);
  }
  const envRaw = process.env.HEALTH_STALE_MS?.trim();
  if (envRaw !== undefined && envRaw !== "") {
    const parsed = Number(envRaw);
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  }
  if (typeof pollIntervalMs === "number" && Number.isFinite(pollIntervalMs) && pollIntervalMs > 0) {
    return Math.max(DEFAULT_OFFLINE_STALE_MS, Math.floor(pollIntervalMs) * 3);
  }
  return DEFAULT_OFFLINE_STALE_MS;
}

function validateStatusSnapshot(parsed: unknown): {
  snapshot: StatusSnapshot | null;
  problems: string[];
} {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { snapshot: null, problems: ["status snapshot must be a JSON object"] };
  }

  const obj = parsed as Record<string, unknown>;
  const problems: string[] = [];

  if (typeof obj.schemaVersion !== "number" || !Number.isInteger(obj.schemaVersion)) {
    problems.push("schemaVersion must be an integer");
  } else if (obj.schemaVersion !== STATUS_SCHEMA_VERSION) {
    problems.push(
      `unsupported status schemaVersion ${obj.schemaVersion} (expected ${STATUS_SCHEMA_VERSION})`,
    );
  }

  if (typeof obj.generatedAt !== "string" || !Number.isFinite(Date.parse(obj.generatedAt))) {
    problems.push("generatedAt must be a valid ISO-8601 timestamp");
  }
  if (typeof obj.running !== "boolean") {
    problems.push("running must be a boolean");
  }
  if (typeof obj.network !== "string" || obj.network.trim() === "") {
    problems.push("network must be a non-empty string");
  }
  if (typeof obj.rpcUrl !== "string" || obj.rpcUrl.trim() === "") {
    problems.push("rpcUrl must be a non-empty string");
  }
  if (typeof obj.chatId !== "string") {
    problems.push("chatId must be a string");
  }
  if (!isNonNegativeInt(obj.pollIntervalMs) || obj.pollIntervalMs < 1) {
    problems.push("pollIntervalMs must be a positive integer");
  }
  if (!isNullableNonNegativeInt(obj.uptimeMs)) {
    problems.push("uptimeMs must be a non-negative integer or null");
  }
  for (const field of [
    "cycles",
    "notificationsSent",
    "notificationsFailed",
    "eventsSkipped",
    "consecutiveFailures",
  ] as const) {
    if (!isNonNegativeInt(obj[field])) {
      problems.push(`${field} must be a non-negative integer`);
    }
  }
  for (const field of ["lastPollAt", "lastSuccessAt", "latestLedger", "oldestLedger"] as const) {
    if (!isNullableNonNegativeInt(obj[field])) {
      problems.push(`${field} must be a non-negative integer or null`);
    }
  }

  if (obj.lastError !== null && obj.lastError !== undefined) {
    if (typeof obj.lastError !== "object" || Array.isArray(obj.lastError)) {
      problems.push("lastError must be an object or null");
    } else {
      const errObj = obj.lastError as Record<string, unknown>;
      if (!isNonNegativeInt(errObj.at) || typeof errObj.message !== "string") {
        problems.push("lastError must include numeric timestamp 'at' and string 'message'");
      }
    }
  } else if (obj.lastError === undefined) {
    problems.push("lastError must be present (object or null)");
  }

  if (!Array.isArray(obj.targets)) {
    problems.push("targets must be an array");
  } else {
    obj.targets.forEach((entry, idx) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        problems.push(`targets[${idx}] must be an object`);
        return;
      }
      const target = entry as Record<string, unknown>;
      if (typeof target.source !== "string" || target.source.trim() === "") {
        problems.push(`targets[${idx}].source must be a non-empty string`);
      }
      if (typeof target.contractId !== "string" || target.contractId.trim() === "") {
        problems.push(`targets[${idx}].contractId must be a non-empty string`);
      }
      if (target.cursor !== null && typeof target.cursor !== "string") {
        problems.push(`targets[${idx}].cursor must be a string or null`);
      }
      if (!isNullableNonNegativeInt(target.lastEventLedger)) {
        problems.push(`targets[${idx}].lastEventLedger must be a non-negative integer or null`);
      }
      if (typeof target.cursorStale !== "boolean") {
        problems.push(`targets[${idx}].cursorStale must be a boolean`);
      }
      if (target.lastError !== null && typeof target.lastError !== "string") {
        problems.push(`targets[${idx}].lastError must be a string or null`);
      }
    });
  }

  if (problems.length > 0) {
    return { snapshot: null, problems };
  }

  return { snapshot: obj as unknown as StatusSnapshot, problems: [] };
}

/**
 * Evaluate raw persisted status file contents into an offline health report
 * suitable for incident bundles without opening any HTTP server or network socket.
 */
export function evaluateOfflineStatusContent(
  raw: string,
  file: string,
  options: OfflineHealthOptions = {},
): OfflineHealthReport {
  const nowMs =
    typeof options.nowMs === "number" && Number.isFinite(options.nowMs)
      ? options.nowMs
      : Date.now();
  const checkedAt = new Date(nowMs).toISOString();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const detail = boundText(err instanceof Error ? err.message : String(err), 120);
    return {
      ok: false,
      status: "malformed",
      mode: "offline",
      service: "mimir-telegram-bot",
      version: APP_VERSION,
      file,
      checkedAt,
      staleThresholdMs: resolveOfflineStaleMs(options.staleMs),
      problems: [`status file is not valid JSON (${redactText(detail)})`],
      snapshot: null,
    };
  }

  const validated = validateStatusSnapshot(parsed);
  if (validated.snapshot === null) {
    return {
      ok: false,
      status: "malformed",
      mode: "offline",
      service: "mimir-telegram-bot",
      version: APP_VERSION,
      file,
      checkedAt,
      staleThresholdMs: resolveOfflineStaleMs(options.staleMs),
      problems: validated.problems,
      snapshot: null,
    };
  }

  const snap = validated.snapshot;
  const staleThresholdMs = resolveOfflineStaleMs(options.staleMs, snap.pollIntervalMs);
  const generatedMs = Date.parse(snap.generatedAt);
  const ageMs = Math.max(0, nowMs - generatedMs);
  const lastSuccessAgeMs =
    snap.lastSuccessAt === null ? null : Math.max(0, nowMs - snap.lastSuccessAt);

  const isSnapshotStale = staleThresholdMs > 0 && ageMs > staleThresholdMs;
  const isSuccessStale =
    snap.running &&
    lastSuccessAgeMs !== null &&
    staleThresholdMs > 0 &&
    lastSuccessAgeMs > staleThresholdMs;

  const failureBudget = Math.max(3, Math.ceil(60_000 / Math.max(snap.pollIntervalMs, 1)));
  const tooManyFailures = snap.consecutiveFailures >= failureBudget;
  const staleTargets = snap.targets.filter((t) => t.cursorStale === true);

  const problems: string[] = [];
  if (isSnapshotStale) {
    problems.push(`status snapshot is stale (age ${ageMs}ms exceeds ${staleThresholdMs}ms)`);
  }
  if (isSuccessStale) {
    problems.push(
      `last successful poll is stale (age ${lastSuccessAgeMs}ms exceeds ${staleThresholdMs}ms)`,
    );
  }
  if (!snap.running) {
    problems.push("poller is stopped in persisted status snapshot");
  }
  if (staleTargets.length > 0) {
    const names = staleTargets.map((t) => boundText(t.source, 32)).join(", ");
    problems.push(`target cursor marked stale (${names})`);
  }
  if (tooManyFailures) {
    problems.push(
      `consecutive poll failures (${snap.consecutiveFailures}) reached threshold (${failureBudget})`,
    );
  }

  let status: OfflineHealthState;
  if (isSnapshotStale || isSuccessStale) {
    status = "stale";
  } else if (!snap.running) {
    status = "stopped";
  } else if (tooManyFailures || staleTargets.length > 0) {
    status = "degraded";
  } else {
    status = "ok";
  }

  return {
    ok: status === "ok",
    status,
    mode: "offline",
    service: "mimir-telegram-bot",
    version: APP_VERSION,
    file,
    checkedAt,
    staleThresholdMs,
    problems,
    snapshot: {
      schemaVersion: snap.schemaVersion,
      generatedAt: new Date(generatedMs).toISOString(),
      ageMs,
      stale: isSnapshotStale || isSuccessStale,
      running: snap.running,
      network: boundText(snap.network, 64),
      rpcUrl: redactUrl(snap.rpcUrl),
      chatId: redactChatId(snap.chatId),
      pollIntervalMs: snap.pollIntervalMs,
      uptimeMs: snap.uptimeMs,
      cycles: snap.cycles,
      lastPollAt: iso(snap.lastPollAt),
      lastSuccessAt: iso(snap.lastSuccessAt),
      lastSuccessAgeMs,
      latestLedger: snap.latestLedger,
      oldestLedger: snap.oldestLedger,
      notificationsSent: snap.notificationsSent,
      notificationsFailed: snap.notificationsFailed,
      eventsSkipped: snap.eventsSkipped,
      eventsDeduplicated: isNonNegativeInt(snap.eventsDeduplicated) ? snap.eventsDeduplicated : 0,
      cursorRewinds: isNonNegativeInt(snap.cursorRewinds) ? snap.cursorRewinds : 0,
      consecutiveFailures: snap.consecutiveFailures,
      sendTimeouts: isNonNegativeInt(snap.sendTimeouts) ? snap.sendTimeouts : 0,
      lastError: snap.lastError
        ? {
            at: new Date(snap.lastError.at).toISOString(),
            message: redactText(boundText(snap.lastError.message)),
          }
        : null,
      targets: snap.targets.map((t) => ({
        source: boundText(t.source, 32),
        contractId: boundText(t.contractId, 64),
        lastCycleMs: isNonNegativeInt(t.lastCycleMs) ? t.lastCycleMs : 0,
        maxCycleMs: isNonNegativeInt(t.maxCycleMs) ? t.maxCycleMs : 0,
        cursorPreview: previewCursor(t.cursor),
        lastEventLedger: t.lastEventLedger,
        rewindFromLedger: isNullableNonNegativeInt(t.rewindFromLedger) ? t.rewindFromLedger : null,
        cursorStale: t.cursorStale === true,
        hasError: t.lastError !== null,
        lastError: t.lastError === null ? null : redactText(boundText(t.lastError)),
      })),
    },
  };
}

/**
 * Read a persisted status file (`STATUS_FILE` by default) and build an offline
 * health report without opening any server or requiring Telegram/RPC credentials.
 */
export async function readOfflineHealthReport(
  file: string = resolveStatusFile(),
  options: OfflineHealthOptions = {},
): Promise<OfflineHealthReport> {
  const nowMs =
    typeof options.nowMs === "number" && Number.isFinite(options.nowMs)
      ? options.nowMs
      : Date.now();
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    const reason =
      code === "ENOENT"
        ? "status file not found"
        : `status file unreadable (${redactText(boundText(safeErrorMessage(err), 120))})`;
    return {
      ok: false,
      status: "missing",
      mode: "offline",
      service: "mimir-telegram-bot",
      version: APP_VERSION,
      file,
      checkedAt: new Date(nowMs).toISOString(),
      staleThresholdMs: resolveOfflineStaleMs(options.staleMs),
      problems: [reason],
      snapshot: null,
    };
  }

  return evaluateOfflineStatusContent(raw, file, options);
}

/**
 * Render an {@link OfflineHealthReport} as a concise, redacted text summary for
 * operator terminals and incident bundles.
 */
export function formatOfflineHealthReport(report: OfflineHealthReport): string {
  const lines: string[] = [
    `[health:offline] status=${report.status.toUpperCase()} ok=${report.ok} file=${report.file}`,
    `  checkedAt: ${report.checkedAt} (staleThresholdMs=${report.staleThresholdMs})`,
  ];

  if (report.snapshot !== null) {
    const s = report.snapshot;
    lines.push(
      `  snapshot: schema=v${s.schemaVersion} generatedAt=${s.generatedAt} ageMs=${s.ageMs} running=${s.running}`,
      `  network: ${s.network} (${s.rpcUrl}) chat=${s.chatId}`,
      `  ledgers: oldest=${s.oldestLedger ?? "unknown"} latest=${s.latestLedger ?? "unknown"}`,
      `  counters: cycles=${s.cycles} sent=${s.notificationsSent} failed=${s.notificationsFailed} skipped=${s.eventsSkipped} consecutiveFailures=${s.consecutiveFailures}`,
    );
    for (const target of s.targets) {
      lines.push(
        `  target[${target.source}]: contract=${target.contractId} ledger=${target.lastEventLedger ?? "none"} cursorStale=${target.cursorStale} hasError=${target.hasError}`,
      );
    }
  }

  if (report.problems.length > 0) {
    lines.push("  problems:");
    for (const problem of report.problems) {
      lines.push(`    - ${problem}`);
    }
  }

  return lines.join("\n");
}
