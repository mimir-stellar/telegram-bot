/**
 * Minimal in-process Prometheus-compatible metrics registry and HTTP server.
 *
 * Design constraints:
 *  - Zero external dependencies. Uses Node's built-in `node:http`.
 *  - Optional: the server is started only when `METRICS_PORT` is set.
 *  - Counters only increment (never reset), so a Prometheus server scraping
 *    them can derive rates with `rate()` / `increase()` reliably.
 *  - Gauges represent momentary state (e.g. consecutive_failures) that can
 *    go up or down.
 *  - The output format is Prometheus text exposition v0.0.4, which every
 *    current Prometheus/OpenMetrics scraper understands.
 *  - Secrets: the /metrics response carries only operational counters derived
 *    from in-process state. It never echoes env vars, bot tokens, or cursor
 *    file contents.
 *
 * Usage:
 *   const metrics = createMetrics();
 *   metrics.pollCycles.inc();
 *   metrics.notificationsSent.inc();
 *   const { close } = await metrics.startServer(9090);
 *   // on shutdown:
 *   await close();
 *
 * Pass a validation failure reason to `metrics.droppedSamples.inc("<reason>")`.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  DEFAULT_SERVICE_LEVEL_WINDOW_SIZE,
  type ServiceLevelCompleteness,
  type ServiceLevelDataGap,
  type ServiceLevelDeliverySuccess,
  type ServiceLevelIncompleteReason,
  type ServiceLevelLag,
  type ServiceLevelSample,
  type ServiceLevelWindowOptions,
  type ServiceLevelWindowReport,
  ServiceLevelWindow,
  formatServiceLevelWindow,
} from "./stellar/metrics.js";

export {
  DEFAULT_SERVICE_LEVEL_WINDOW_SIZE,
  type ServiceLevelCompleteness,
  type ServiceLevelDataGap,
  type ServiceLevelDeliverySuccess,
  type ServiceLevelIncompleteReason,
  type ServiceLevelLag,
  type ServiceLevelSample,
  type ServiceLevelWindowOptions,
  type ServiceLevelWindowReport,
  ServiceLevelWindow,
  formatServiceLevelWindow,
};

// ── Metric types ──────────────────────────────────────────────────────────────

export interface Counter {
  /** Increment by 1 (default) or by `delta` (must be ≥ 0). */
  inc(delta?: number): void;
  /** Current value. */
  value(): number;
}

/**
 * Bounded-cardinality counter keyed by a fixed set of reason labels.
 * Unknown labels are folded into `unknown` so Prometheus cardinality stays bounded.
 */
export interface LabeledCounter {
  /** Increment the counter for `reason` (default 1). Unknown reasons map to "unknown". */
  inc(reason: string, delta?: number): void;
  /** Current value for a reason label. */
  value(reason: string): number;
}

/** Fixed set of reasons a metric sample can be dropped. Bounded for cardinality safety. */
export const DROP_REASONS = [
  "invalid_number",
  "unknown_label",
] as const;

export type DropReason = (typeof DROP_REASONS)[number];

export interface Gauge {
  /** Set to `value`. */
  set(value: number): void;
  /** Current value. */
  value(): number;
}

export interface MetricsServerOptions {
  /**
   * Milliseconds to wait for active or stalled client sockets to close during
   * shutdown before force-closing them. Defaults to
   * {@link DEFAULT_HEALTH_SHUTDOWN_GRACE_MS}; `0` force-closes immediately.
   */
  shutdownGraceMs?: number;
}

export interface MetricsCloseOptions {
  /**
   * Milliseconds to wait for active or stalled client sockets to close during
   * shutdown before force-closing them. Overrides `shutdownGraceMs`.
   */
  gracePeriodMs?: number;
}

/** A running HTTP server returned by {@link MetricsRegistry.startServer}. */
export interface MetricsServer {
  /** The port the server is actually listening on. */
  port: number;
  /** Gracefully close the server. Resolves when the socket is released. */
  close(options?: MetricsCloseOptions): Promise<void>;
}

// ── Registry ──────────────────────────────────────────────────────────────────

/**
 * All metrics exposed at GET /metrics.
 *
 * Naming follows Prometheus conventions:
 *  - `_total` suffix for counters
 *  - `_gauge` suffix / no suffix for gauges
 *  - snake_case throughout
 *  - prefix `mimir_bot_` to avoid collisions in a shared Prometheus instance
 */
export interface MetricsRegistry {
  /** Total poll cycles started (one per POLL_INTERVAL_MS tick). */
  pollCycles: Counter;
  /** Total successful Soroban RPC calls (one per target per cycle on success). */
  rpcRequests: Counter;
  /** Total failed Soroban RPC calls. */
  rpcErrors: Counter;
  /** Total events returned by the RPC and handed to the decoder. */
  eventsDecoded: Counter;
  /** Total events the decoder handed back with payload.name === "unknown", plus
   *  those dropped by the MAX_NOTIFICATIONS_PER_CYCLE cap. */
  eventsSkipped: Counter;
  /** Total events intentionally filtered out (e.g. feature flags or filter rules).
   *  Excluded from the delivery failure-rate denominator. */
  eventsFiltered: Counter;
  /** Intentionally filtered events dropped by NOTIFY_* feature flags. */
  eventsFilteredFeatureFlag: Counter;
  /** Intentionally filtered events dropped by category/filter rules (null formatted text). */
  eventsFilteredRule: Counter;
  /** Total Telegram messages successfully sent. */
  notificationsSent: Counter;
  /** Total Telegram sends that threw (the cursor still advances). */
  notificationsFailed: Counter;
  /** Number of times a stale-cursor warning was emitted this process lifetime. */
  staleCursorEvents: Counter;
  /** Current count of consecutive full-cycle failures (gauge: resets to 0 on
   *  any success). */
  consecutiveFailures: Gauge;
  /** Events observed in the most recent complete poll cycle. */
  lastCycleEvents: Gauge;
  /** Rolling mean events per cycle at the most recent baseline comparison,
   *  rounded to a whole event. */
  activityBaselineEvents: Gauge;
  /** Complete cycles classified as a spike or drop against the rolling
   *  activity baseline. */
  activityAnomalies: Counter;
  /**
   * Samples dropped before exposure, labelled by bounded reason
   * (`invalid_number`, `unknown_label`, or `unknown`).
   */
  droppedSamples: LabeledCounter;
  /** Count one dropped sample under a bounded reason (unknown reasons fold into `unknown`). */
  recordDropped(reason: string): void;
  /** Record a numeric sample for a gauge; non-finite values are dropped and counted. */
  setGaugeSafe(gauge: Gauge, value: number): void;
  /** Total confirmed notifications with a known ledger close time (includes 0ms lag). */
  notificationAgeSamples: Counter;
  /** Total confirmed notifications whose event lacked a valid ledger close time. */
  notificationAgeMissingLedgerTime: Counter;
  /** Cumulative end-to-end notification age in milliseconds across known-ledger-time samples. */
  notificationAgeTotalMs: Counter;
  /** End-to-end age in ms of the most recent confirmed notification with a known ledger time. */
  lastNotificationAgeMs: Gauge;
  /** Maximum observed end-to-end notification age in ms across confirmed sends. */
  maxNotificationAgeMs: Gauge;

  /**
   * Record one confirmed notification's end-to-end age in milliseconds, or `null`
   * when the source event lacked a valid ledger close time. Distinguishes missing
   * ledger time (`notificationAgeMissingLedgerTime`) from zero delivery lag
   * (`notificationAgeSamples` incremented with `0` ms).
   */
  recordNotificationAge(ageMs: number | null): void;

  /** Bounded rolling service-level window tracker. */
  serviceLevel: ServiceLevelWindow;

  /**
   * Generate the machine-readable service-level window report from bounded local samples.
   */
  serviceLevelReport(): ServiceLevelWindowReport;

  /**
   * Record a delivery attempt into the service-level window.
   */
  recordDelivery(
    success: boolean,
    ageMs?: number | null,
    dataGap?: boolean,
    gapReason?: ServiceLevelIncompleteReason,
  ): void;

  /**
   * Record a data gap event into the service-level window.
   */
  recordDataGap(reason?: ServiceLevelIncompleteReason): void;

  /**
   * Render the registry as a Prometheus text exposition string.
   * Includes HELP and TYPE comment lines so Prometheus autodiscovery works.
   */
  render(): string;

  /**
   * Start an HTTP server on `port` that serves GET /metrics.
   *
   * Also serves GET /health (returns `200 OK\n`) as a minimal liveness probe.
   * Any other method or path returns 404.
   *
   * The server binds to 127.0.0.1 by default so it is not exposed to the
   * network without an explicit proxy. On a Docker host set METRICS_HOST or
   * bind via the compose port mapping instead.
   *
   * @param port TCP port (1–65535). Caller is responsible for validating this
   *             before calling startServer (see config.ts).
   * @param host Bind address (default: "127.0.0.1").
   * @param options Optional server lifecycle tuning (such as `shutdownGraceMs`).
   */
  startServer(port: number, host?: string, options?: MetricsServerOptions): Promise<MetricsServer>;
}

// ── Implementation ────────────────────────────────────────────────────────────

function makeCounter(name: string, help: string): Counter & { _name: string; _help: string } {
  let _value = 0;
  return {
    _name: name,
    _help: help,
    inc(delta = 1): void {
      if (delta < 0) throw new RangeError(`Counter.inc delta must be >= 0; got ${delta}`);
      _value += delta;
    },
    value(): number {
      return _value;
    },
  };
}

function makeFiniteGauge(
  name: string,
  help: string,
  onDrop: (reason: DropReason) => void,
): Gauge & { _name: string; _help: string } {
  let _value = 0;
  return {
    _name: name,
    _help: help,
    set(value: number): void {
      if (!Number.isFinite(value)) {
        onDrop("invalid_number");
        return;
      }
      _value = value;
    },
    value(): number {
      return _value;
    },
  };
}

const METRICS_PREFIX = "mimir_bot_";

function makeLabeledCounter(name: string, help: string, labels: readonly string[]): LabeledCounter & { _name: string; _help: string; _labels: readonly string[]; _entries(): [string, number][] } {
  const values = new Map<string, number>(labels.map((l) => [l, 0]));
  const known = new Set<string>(labels);
  return {
    _name: name,
    _help: help,
    _labels: labels,
    inc(reason: string, delta = 1): void {
      if (delta < 0) throw new RangeError(`LabeledCounter.inc delta must be >= 0; got ${delta}`);
      const key = known.has(reason) ? reason : "unknown";
      values.set(key, (values.get(key) ?? 0) + delta);
    },
    value(reason: string): number {
      return values.get(known.has(reason) ? reason : "unknown") ?? 0;
    },
    _entries(): [string, number][] {
      return [...values.entries()];
    },
  };
}

export interface MetricsOptions {
  /** Optional capacity of the bounded rolling service-level window. */
  serviceLevelWindowSize?: number | undefined;
}

export function createMetrics(options?: MetricsOptions): MetricsRegistry {
  const droppedSamples = makeLabeledCounter(
    `${METRICS_PREFIX}dropped_samples_total`,
    "Metric samples dropped before exposure, by bounded reason.",
    [...DROP_REASONS, "unknown"],
  );
  // Every gauge drops (and counts) non-finite samples instead of exposing them.
  const makeGauge = (name: string, help: string) =>
    makeFiniteGauge(name, help, (reason) => droppedSamples.inc(reason));
  const serviceLevel = new ServiceLevelWindow({
    windowSize: options?.serviceLevelWindowSize,
  });
  const pollCycles = makeCounter(
    `${METRICS_PREFIX}poll_cycles_total`,
    "Total number of poll cycles started.",
  );
  const rpcRequests = makeCounter(
    `${METRICS_PREFIX}rpc_requests_total`,
    "Total successful Soroban RPC getEvents calls.",
  );
  const rpcErrors = makeCounter(
    `${METRICS_PREFIX}rpc_errors_total`,
    "Total failed Soroban RPC getEvents calls.",
  );
  const eventsDecoded = makeCounter(
    `${METRICS_PREFIX}events_decoded_total`,
    "Total on-chain events returned by the RPC and passed through the decoder.",
  );
  const eventsSkipped = makeCounter(
    `${METRICS_PREFIX}events_skipped_total`,
    "Total events not notified: unknown type, no formatter, or MAX_NOTIFICATIONS_PER_CYCLE cap.",
  );
  const eventsFiltered = makeCounter(
    `${METRICS_PREFIX}events_filtered_total`,
    "Total events intentionally filtered out (excluded from failure-rate denominator).",
  );
  const eventsFilteredFeatureFlag = makeCounter(
    `${METRICS_PREFIX}events_filtered_feature_flag_total`,
    "Total events intentionally filtered out by NOTIFY_* feature flags.",
  );
  const eventsFilteredRule = makeCounter(
    `${METRICS_PREFIX}events_filtered_rule_total`,
    "Total events intentionally filtered out by category or filter rules.",
  );
  const notificationsSent = makeCounter(
    `${METRICS_PREFIX}notifications_sent_total`,
    "Total Telegram messages successfully sent.",
  );
  const notificationsFailed = makeCounter(
    `${METRICS_PREFIX}notifications_failed_total`,
    "Total Telegram sends that threw an error (cursor still advanced).",
  );
  const staleCursorEvents = makeCounter(
    `${METRICS_PREFIX}stale_cursor_events_total`,
    "Number of times a stale-cursor warning was emitted (events in the gap are lost).",
  );
  const consecutiveFailures = makeGauge(
    `${METRICS_PREFIX}consecutive_failures`,
    "Current number of consecutive full-cycle RPC failures (resets to 0 on any success).",
  );
  const lastCycleEvents = makeGauge(
    `${METRICS_PREFIX}last_cycle_events`,
    "Events observed in the most recent complete poll cycle.",
  );
  const activityBaselineEvents = makeGauge(
    `${METRICS_PREFIX}activity_baseline_events`,
    "Rolling mean events per cycle at the most recent baseline comparison (rounded).",
  );
  const activityAnomalies = makeCounter(
    `${METRICS_PREFIX}activity_anomalies_total`,
    "Complete poll cycles classified as a spike or drop against the rolling activity baseline.",
  );
  const notificationAgeSamples = makeCounter(
    `${METRICS_PREFIX}notification_age_samples_total`,
    "Total confirmed notifications with a known ledger close time (includes 0ms lag).",
  );
  const notificationAgeMissingLedgerTime = makeCounter(
    `${METRICS_PREFIX}notification_age_missing_ledger_time_total`,
    "Total confirmed notifications whose event lacked a valid ledger close time.",
  );
  const notificationAgeTotalMs = makeCounter(
    `${METRICS_PREFIX}notification_age_ms_total`,
    "Cumulative end-to-end notification age in milliseconds from ledger close time to confirmed send.",
  );
  const lastNotificationAgeMs = makeGauge(
    `${METRICS_PREFIX}last_notification_age_ms`,
    "End-to-end age in milliseconds of the most recent confirmed notification with a known ledger close time.",
  );
  const maxNotificationAgeMs = makeGauge(
    `${METRICS_PREFIX}max_notification_age_ms`,
    "Maximum observed end-to-end notification age in milliseconds from ledger close time to confirmed send.",
  );

  const counters = [
    pollCycles,
    rpcRequests,
    rpcErrors,
    eventsDecoded,
    eventsSkipped,
    eventsFiltered,
    eventsFilteredFeatureFlag,
    eventsFilteredRule,
    notificationsSent,
    notificationsFailed,
    staleCursorEvents,
    activityAnomalies,
    notificationAgeSamples,
    notificationAgeMissingLedgerTime,
    notificationAgeTotalMs,
  ];
  const gauges = [
    consecutiveFailures,
    lastCycleEvents,
    activityBaselineEvents,
    lastNotificationAgeMs,
    maxNotificationAgeMs,
  ];

  const baseFailedInc = notificationsFailed.inc;
  notificationsFailed.inc = (delta = 1) => {
    baseFailedInc(delta);
    for (let i = 0; i < delta; i += 1) {
      serviceLevel.recordDelivery(false, null);
    }
  };

  const baseStaleCursorInc = staleCursorEvents.inc;
  staleCursorEvents.inc = (delta = 1) => {
    baseStaleCursorInc(delta);
    for (let i = 0; i < delta; i += 1) {
      serviceLevel.recordDataGap("stale_cursor");
    }
  };

  function recordNotificationAge(ageMs: number | null): void {
    if (ageMs === null || typeof ageMs !== "number" || !Number.isFinite(ageMs)) {
      notificationAgeMissingLedgerTime.inc();
      serviceLevel.recordDelivery(true, null, true, "missing_ledger_time");
      return;
    }
    const clampedMs = Math.max(0, Math.round(ageMs));
    notificationAgeSamples.inc();
    notificationAgeTotalMs.inc(clampedMs);
    lastNotificationAgeMs.set(clampedMs);
    if (clampedMs > maxNotificationAgeMs.value()) {
      maxNotificationAgeMs.set(clampedMs);
    }
    serviceLevel.recordDelivery(true, clampedMs, false);
  }

  function render(): string {
    const lines: string[] = [];

    for (const c of counters) {
      lines.push(`# HELP ${c._name} ${c._help}`);
      lines.push(`# TYPE ${c._name} counter`);
      lines.push(`${c._name} ${c.value()}`);
    }

    lines.push(`# HELP ${droppedSamples._name} ${droppedSamples._help}`);
    lines.push(`# TYPE ${droppedSamples._name} counter`);
    for (const [reason, v] of droppedSamples._entries()) {
      lines.push(`${droppedSamples._name}{reason="${reason}"} ${v}`);
    }

    for (const g of gauges) {
      lines.push(`# HELP ${g._name} ${g._help}`);
      lines.push(`# TYPE ${g._name} gauge`);
      lines.push(`${g._name} ${g.value()}`);
    }

    // Prometheus text format requires a trailing newline.
    return lines.join("\n") + "\n";
  }

  function resolveGraceMs(overrideMs: number | undefined, defaultMs: number | undefined): number {
    if (typeof overrideMs === "number" && Number.isFinite(overrideMs)) {
      return Math.max(0, Math.trunc(overrideMs));
    }
    if (typeof defaultMs === "number" && Number.isFinite(defaultMs)) {
      return Math.max(0, Math.trunc(defaultMs));
    }
    return DEFAULT_HEALTH_SHUTDOWN_GRACE_MS;
  }

  function handleRequest(req: IncomingMessage, res: ServerResponse, closing = false): void {
    if (closing) {
      res.setHeader("Connection", "close");
    }

    const method = req.method ?? "GET";
    const url = req.url ?? "/";

    // Only GET is meaningful for a read-only metrics endpoint.
    if (method !== "GET") {
      res.writeHead(405, {
        "Content-Type": "text/plain",
        Allow: "GET",
        "Cache-Control": "no-store",
      });
      res.end("Method Not Allowed\n");
      return;
    }

    // Strip query strings: /metrics?debug=1 should still serve metrics.
    const path = url.split("?")[0] ?? "/";

    if (path === "/metrics") {
      const body = render();
      res.writeHead(200, {
        "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        // Instruct proxies not to cache — stale metrics are misleading.
        "Cache-Control": "no-store",
        ...(closing ? { Connection: "close" } : {}),
      });
      res.end(body);
      return;
    }

    if (path === "/health") {
      res.writeHead(200, {
        "Content-Type": "text/plain",
        "Cache-Control": "no-store",
      });
      res.end("OK\n");
      return;
    }

    if (path === "/service-level") {
      const report = serviceLevel.report();
      const body = JSON.stringify(report, null, 2) + "\n";
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store",
      });
      res.end(body);
      return;
    }

    res.writeHead(404, {
      "Content-Type": "text/plain",
      "Cache-Control": "no-store",
    });
    res.end("Not Found\n");
  }

  function startServer(
    port: number,
    host = "127.0.0.1",
    options?: MetricsServerOptions,
  ): Promise<MetricsServer> {
    return new Promise((resolve, reject) => {
      const sockets = new Set<Socket>();
      let closing = false;
      let closePromise: Promise<void> | null = null;

      const server = createServer((req, res) => {
        handleRequest(req, res, closing);
      });

      server.on("connection", (socket: Socket) => {
        sockets.add(socket);
        socket.once("close", () => {
          sockets.delete(socket);
        });
      });

      const forceDestroySockets = (): void => {
        server.closeAllConnections?.();
        for (const socket of sockets) {
          if (!socket.destroyed) socket.destroy();
        }
      };

      server.once("error", reject);

      server.listen(port, host, () => {
        const addr = server.address();
        const actualPort = addr && typeof addr === "object" ? addr.port : port;

        console.log(`[metrics] server listening on http://${host}:${actualPort}/metrics`);

        const metricsServer: MetricsServer = {
          port: actualPort,
          close(closeOptions?: MetricsCloseOptions): Promise<void> {
            if (closePromise !== null) return closePromise;
            closing = true;
            const graceMs = resolveGraceMs(
              closeOptions?.gracePeriodMs,
              options?.shutdownGraceMs,
            );

            closePromise = new Promise((res, rej) => {
              let timer: NodeJS.Timeout | null = null;
              const clearTimer = (): void => {
                if (timer !== null) {
                  clearTimeout(timer);
                  timer = null;
                }
              };

              server.close((err) => {
                clearTimer();
                if (err) rej(err);
                else res();
              });

              server.closeIdleConnections?.();

              if (graceMs <= 0) {
                forceDestroySockets();
              } else if (sockets.size > 0) {
                timer = setTimeout(() => {
                  timer = null;
                  forceDestroySockets();
                }, graceMs);
                timer.unref();
              }
            });

            return closePromise;
          },
        };

        resolve(metricsServer);
      });
    });
  }

  return {
    pollCycles,
    rpcRequests,
    rpcErrors,
    eventsDecoded,
    eventsSkipped,
    eventsFiltered,
    eventsFilteredFeatureFlag,
    eventsFilteredRule,
    notificationsSent,
    notificationsFailed,
    staleCursorEvents,
    consecutiveFailures,
    lastCycleEvents,
    activityBaselineEvents,
    activityAnomalies,
    droppedSamples,
    recordDropped(reason: string): void {
      droppedSamples.inc(reason);
    },
    setGaugeSafe(gauge: Gauge, value: number): void {
      if (!Number.isFinite(value)) {
        droppedSamples.inc("invalid_number");
        return;
      }
      gauge.set(value);
    },
    notificationAgeSamples,
    notificationAgeMissingLedgerTime,
    notificationAgeTotalMs,
    lastNotificationAgeMs,
    maxNotificationAgeMs,
    recordNotificationAge,
    serviceLevel,
    serviceLevelReport(): ServiceLevelWindowReport {
      return serviceLevel.report();
    },
    recordDelivery(
      success: boolean,
      ageMs?: number | null,
      dataGap?: boolean,
      gapReason?: ServiceLevelIncompleteReason,
    ): void {
      serviceLevel.recordDelivery(success, ageMs, dataGap, gapReason);
    },
    recordDataGap(reason?: ServiceLevelIncompleteReason): void {
      serviceLevel.recordDataGap(reason);
    },
    render,
    startServer,
  };
}

export type Metrics = ReturnType<typeof createMetrics>;

/**
 * Compute the delivery failure rate over actual delivery attempts (`sent + failed`).
 * Intentionally filtered events are excluded from the denominator.
 */
export function deliveryFailureRate(sent: number, failed: number): number {
  const attempts = sent + failed;
  if (attempts <= 0 || !Number.isFinite(attempts)) return 0;
  return failed / attempts;
}