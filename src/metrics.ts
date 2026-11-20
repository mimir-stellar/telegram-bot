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
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

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

export interface Gauge {
  /** Set to `value`. */
  set(value: number): void;
  /** Current value. */
  value(): number;
}

/** A running HTTP server returned by {@link MetricsRegistry.startServer}. */
export interface MetricsServer {
  /** The port the server is actually listening on. */
  port: number;
  /** Gracefully close the server. Resolves when the socket is released. */
  close(): Promise<void>;
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
   */
  startServer(port: number, host?: string): Promise<MetricsServer>;
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

    // Prometheus text format requires a trailing newline.
    return lines.join("\n") + "\n";
  }

  function handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const method = req.method ?? "GET";
    const url = req.url ?? "/";

    // Only GET is meaningful for a read-only metrics endpoint.
    if (method !== "GET") {
      res.writeHead(405, { "Content-Type": "text/plain", Allow: "GET" });
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
      });
      res.end(body);
      return;
    }

    if (path === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("OK\n");
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found\n");
  }

  function startServer(port: number, host = "127.0.0.1"): Promise<MetricsServer> {
    return new Promise((resolve, reject) => {
      const server = createServer(handleRequest);

      server.once("error", reject);

      server.listen(port, host, () => {
        const addr = server.address();
        const actualPort = addr && typeof addr === "object" ? addr.port : port;

        console.log(`[metrics] server listening on http://${host}:${actualPort}/metrics`);

        const metricsServer: MetricsServer = {
          port: actualPort,
          close(): Promise<void> {
            return new Promise((res, rej) => {
              server.close((err) => {
                if (err) rej(err);
                else res();
              });
            });
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
    notificationsSent,
    notificationsFailed,
    staleCursorEvents,
    consecutiveFailures,
    lastCycleEvents,
    activityBaselineEvents,
    activityAnomalies,
    render,
    startServer,
    register,
  } as unknown as MetricsRegistry;
}

export type Metrics = ReturnType<typeof createMetrics>;
