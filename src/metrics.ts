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
 *  - Duplicate registration: a second call to register() with the same name
 *    is accepted silently when the type and help string are identical
 *    (idempotent). A conflicting type or help string throws
 *    MetricRegistrationError so callers find mismatches at construction time
 *    rather than producing corrupt Prometheus exposition output.
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

/** The two Prometheus metric kinds this registry supports. */
export type MetricType = "counter" | "gauge";

/**
 * Thrown when a name is registered a second time with a different type or a
 * different help string. Identical re-registration is accepted silently.
 *
 * The message is deterministic and value-free: it names the metric name, the
 * field that conflicted (`type` or `help`), and the existing vs. attempted
 * values, so the caller can fix the mismatch without reading private state.
 */
export class MetricRegistrationError extends Error {
  constructor(
    public readonly metricName: string,
    public readonly field: "type" | "help",
    public readonly existing: string,
    public readonly attempted: string,
  ) {
    super(
      `Metric "${metricName}" is already registered with ${field} "${existing}"; ` +
        `cannot re-register with ${field} "${attempted}"`,
    );
    this.name = "MetricRegistrationError";
  }
}

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

/**
 * Stable, low-cardinality destination classes for pending delivery queue age.
 * Never use chat IDs or event IDs as labels.
 */
export type DeliveryDestinationClass = "channel" | "group" | "dm" | "dead_letter";

export const DELIVERY_DESTINATION_CLASSES: readonly DeliveryDestinationClass[] = [
  "channel",
  "group",
  "dm",
  "dead_letter",
] as const;

/** Fixed finite upper bounds (in seconds) for pending delivery queue age histograms. */
export const QUEUE_AGE_BUCKETS_SECONDS: readonly number[] = [
  1, 5, 15, 30, 60, 300, 900, 3600,
] as const;

export interface QueueAgeBucketSnapshot {
  /** Upper bound in seconds, or `"+Inf"` for the cumulative catch-all bucket. */
  le: number | "+Inf";
  /** Cumulative count of observations less than or equal to `le`. */
  count: number;
}

export interface QueueAgeDestinationSnapshot {
  buckets: QueueAgeBucketSnapshot[];
  sum: number;
  count: number;
}

export interface QueueAgeHistogram {
  /** Fixed finite bucket upper bounds in seconds (excluding `+Inf`). */
  readonly buckets: readonly number[];
  /** Stable destination classes accepted by this histogram. */
  readonly destinations: readonly DeliveryDestinationClass[];
  /**
   * Observe a pending delivery queue age in seconds for a stable destination class.
   * Throws `RangeError` for unknown destination classes (e.g. chat IDs or event IDs)
   * or negative/non-finite ages.
   */
  observe(destination: DeliveryDestinationClass, ageSeconds: number): void;
  /**
   * Observe a pending delivery queue age computed from `nowMs - enqueuedAtMs`.
   * Clock skew (`nowMs < enqueuedAtMs`) is clamped to 0 seconds.
   * Throws `RangeError` for unknown destination classes or non-finite timestamps.
   */
  observeSince(destination: DeliveryDestinationClass, enqueuedAtMs: number, nowMs?: number): void;
  /** Return a snapshot of cumulative bucket counts, sum, and count for `destination`. */
  snapshot(destination: DeliveryDestinationClass): QueueAgeDestinationSnapshot;
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
  /** Fixed-bucket queue age histogram (in seconds) for pending deliveries,
   *  partitioned by stable destination class (never chat IDs or event IDs). */
  pendingDeliveryQueueAge: QueueAgeHistogram;

  /**
   * Render the registry as a Prometheus text exposition string.
   * Includes HELP and TYPE comment lines so Prometheus autodiscovery works.
   */
  render(): string;

  /**
   * Register a metric by name.
   *
   * - **First call** for a name: creates and stores the metric, returns it.
   * - **Identical re-registration** (same `name`, `type`, and `help`): returns
   *   the existing metric unchanged — safe to call from module-level init code
   *   that runs more than once (e.g. in tests that share a registry, or in a
   *   module that is imported by multiple callers).
   * - **Conflicting re-registration** (same `name`, different `type` or
   *   `help`): throws {@link MetricRegistrationError}. A conflict at
   *   construction time is far easier to debug than a silent corruption of the
   *   Prometheus exposition output that only surfaces when a scraper complains.
   *
   * The returned metric is typed as `Counter` when `type === "counter"` and
   * as `Gauge` when `type === "gauge"`. Use the overloads to get the precise
   * type back without an explicit cast.
   */
  register(name: string, type: "counter", help: string): Counter;
  register(name: string, type: "gauge", help: string): Gauge;
  register(name: string, type: MetricType, help: string): Counter | Gauge;

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

function makeCounter(): Counter {
  let _value = 0;
  return {
    inc(delta = 1): void {
      if (delta < 0) throw new RangeError(`Counter.inc delta must be >= 0; got ${delta}`);
      _value += delta;
    },
    value(): number {
      return _value;
    },
  };
}

function makeGauge(): Gauge {
  let _value = 0;
  return {
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

/**
 * Internal record for one registered metric. `metric` is the live handle the
 * caller mutates; `type` is what the `# TYPE` line must emit so a re-registered
 * gauge can never be silently retyped as a counter (or vice versa).
 */
interface RegisteredMetric {
  name: string;
  type: MetricType;
  help: string;
  metric: Counter | Gauge;
}

const METRICS_PREFIX = "mimir_bot_";

export function createMetrics(): MetricsRegistry {
  /** Insertion-ordered registry of every metric this instance has created. */
  const registry = new Map<string, RegisteredMetric>();

  /**
   * Create a metric on first sight, or return the existing one on an identical
   * re-registration. Reject conflicts on `type` or `help` loudly.
   */
  function register(name: string, type: MetricType, help: string): Counter | Gauge {
    const existing = registry.get(name);
    if (existing !== undefined) {
      if (existing.type !== type) {
        throw new MetricRegistrationError(name, "type", existing.type, type);
      }
      if (existing.help !== help) {
        throw new MetricRegistrationError(name, "help", existing.help, help);
      }
      return existing.metric;
    }

    const metric =
      type === "counter"
        ? makeCounter()
        : makeGauge();
    registry.set(name, { name, type, help, metric });
    return metric;
  }

  const pollCycles = register(
    `${METRICS_PREFIX}poll_cycles_total`,
    "counter",
    "Total number of poll cycles started.",
  ) as Counter;
  const rpcRequests = register(
    `${METRICS_PREFIX}rpc_requests_total`,
    "counter",
    "Total successful Soroban RPC getEvents calls.",
  ) as Counter;
  const rpcErrors = register(
    `${METRICS_PREFIX}rpc_errors_total`,
    "counter",
    "Total failed Soroban RPC getEvents calls.",
  ) as Counter;
  const eventsDecoded = register(
    `${METRICS_PREFIX}events_decoded_total`,
    "counter",
    "Total on-chain events returned by the RPC and passed through the decoder.",
  ) as Counter;
  const eventsSkipped = register(
    `${METRICS_PREFIX}events_skipped_total`,
    "counter",
    "Total events not notified: unknown type, no formatter, or MAX_NOTIFICATIONS_PER_CYCLE cap.",
  ) as Counter;
  const notificationsSent = register(
    `${METRICS_PREFIX}notifications_sent_total`,
    "counter",
    "Total Telegram messages successfully sent.",
  ) as Counter;
  const notificationsFailed = register(
    `${METRICS_PREFIX}notifications_failed_total`,
    "counter",
    "Total Telegram sends that threw an error (cursor still advanced).",
  ) as Counter;
  const staleCursorEvents = register(
    `${METRICS_PREFIX}stale_cursor_events_total`,
    "counter",
    "Number of times a stale-cursor warning was emitted (events in the gap are lost).",
  ) as Counter;
  const consecutiveFailures = register(
    `${METRICS_PREFIX}consecutive_failures`,
    "gauge",
    "Current number of consecutive full-cycle RPC failures (resets to 0 on any success).",
  ) as Gauge;
  const lastCycleEvents = register(
    `${METRICS_PREFIX}last_cycle_events`,
    "gauge",
    "Events observed in the most recent complete poll cycle.",
  ) as Gauge;
  const activityBaselineEvents = register(
    `${METRICS_PREFIX}activity_baseline_events`,
    "gauge",
    "Rolling mean events per cycle at the most recent baseline comparison (rounded).",
  ) as Gauge;
  const activityAnomalies = register(
    `${METRICS_PREFIX}activity_anomalies_total`,
    "counter",
    "Complete poll cycles classified as a spike or drop against the rolling activity baseline.",
  ) as Counter;

  function render(): string {
    const lines: string[] = [];

    for (const { name, type, help, metric } of registry.values()) {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} ${type}`);
      lines.push(`${name} ${metric.value()}`);
    }

    for (const h of histograms) {
      lines.push(`# HELP ${h._name} ${h._help}`);
      lines.push(`# TYPE ${h._name} histogram`);
      for (const destination of h.destinations) {
        const snap = h.snapshot(destination);
        for (const bucket of snap.buckets) {
          lines.push(
            `${h._name}_bucket{destination="${destination}",le="${bucket.le}"} ${bucket.count}`,
          );
        }
        lines.push(`${h._name}_sum{destination="${destination}"} ${snap.sum}`);
        lines.push(`${h._name}_count{destination="${destination}"} ${snap.count}`);
      }
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
    pendingDeliveryQueueAge,
    render,
    startServer,
    register,
  } as unknown as MetricsRegistry;
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