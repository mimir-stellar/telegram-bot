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
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

// ── Metric types ──────────────────────────────────────────────────────────────

export type MetricType = "counter" | "gauge";

export type MetricRegistrationErrorReason =
  | "invalid-name"
  | "invalid-help"
  | "type-conflict"
  | "help-conflict";

/**
 * Thrown when a caller attempts to register an invalid metric definition or a
 * duplicate metric name whose `type` or `help` conflicts with the existing
 * registration. Rejecting at registration time prevents duplicate or
 * contradictory `# HELP` / `# TYPE` headers from corrupting Prometheus text
 * exposition.
 */
export class MetricRegistrationError extends Error {
  readonly metricName: string;
  readonly reason: MetricRegistrationErrorReason;

  constructor(metricName: string, reason: MetricRegistrationErrorReason, message: string) {
    super(message);
    this.name = "MetricRegistrationError";
    this.metricName = metricName;
    this.reason = reason;
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
   * Register a counter metric in this registry, or return the existing handle
   * when `name` is already registered as a counter with the exact same `help`.
   * Throws {@link MetricRegistrationError} on invalid `name`/`help` or when an
   * existing metric with `name` has a different `type` or `help`.
   */
  registerCounter(name: string, help: string): Counter;

  /**
   * Register a gauge metric in this registry, or return the existing handle
   * when `name` is already registered as a gauge with the exact same `help`.
   * Throws {@link MetricRegistrationError} on invalid `name`/`help` or when an
   * existing metric with `name` has a different `type` or `help`.
   */
  registerGauge(name: string, help: string): Gauge;

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
   */
  startServer(port: number, host?: string): Promise<MetricsServer>;
}

// ── Implementation ────────────────────────────────────────────────────────────

const METRIC_NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

function validateMetricDefinition(name: string, help: string): void {
  if (typeof name !== "string" || !METRIC_NAME_RE.test(name)) {
    throw new MetricRegistrationError(
      String(name),
      "invalid-name",
      `Invalid Prometheus metric name "${String(name)}": must match ${METRIC_NAME_RE}`,
    );
  }
  if (typeof help !== "string" || help.trim().length === 0 || /[\r\n\0]/.test(help)) {
    throw new MetricRegistrationError(
      name,
      "invalid-help",
      `Invalid HELP string for metric "${name}": must be a non-empty single-line string`,
    );
  }
}

function escapeHelp(help: string): string {
  return help.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

type RegisteredEntry =
  | { name: string; help: string; type: "counter"; handle: Counter }
  | { name: string; help: string; type: "gauge"; handle: Gauge };

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

const METRICS_PREFIX = "mimir_bot_";

export function createMetrics(): MetricsRegistry {
  const registered = new Map<string, RegisteredEntry>();

  function registerCounter(name: string, help: string): Counter {
    validateMetricDefinition(name, help);
    const existing = registered.get(name);
    if (existing !== undefined) {
      if (existing.type !== "counter") {
        throw new MetricRegistrationError(
          name,
          "type-conflict",
          `Cannot register metric "${name}" as counter: already registered as ${existing.type}`,
        );
      }
      if (existing.help !== help) {
        throw new MetricRegistrationError(
          name,
          "help-conflict",
          `Cannot register metric "${name}": HELP text conflicts with existing registration`,
        );
      }
      return existing.handle;
    }
    const handle = makeCounter();
    registered.set(name, { name, help, type: "counter", handle });
    return handle;
  }

  function registerGauge(name: string, help: string): Gauge {
    validateMetricDefinition(name, help);
    const existing = registered.get(name);
    if (existing !== undefined) {
      if (existing.type !== "gauge") {
        throw new MetricRegistrationError(
          name,
          "type-conflict",
          `Cannot register metric "${name}" as gauge: already registered as ${existing.type}`,
        );
      }
      if (existing.help !== help) {
        throw new MetricRegistrationError(
          name,
          "help-conflict",
          `Cannot register metric "${name}": HELP text conflicts with existing registration`,
        );
      }
      return existing.handle;
    }
    const handle = makeGauge();
    registered.set(name, { name, help, type: "gauge", handle });
    return handle;
  }

  const pollCycles = registerCounter(
    `${METRICS_PREFIX}poll_cycles_total`,
    "Total number of poll cycles started.",
  );
  const rpcRequests = registerCounter(
    `${METRICS_PREFIX}rpc_requests_total`,
    "Total successful Soroban RPC getEvents calls.",
  );
  const rpcErrors = registerCounter(
    `${METRICS_PREFIX}rpc_errors_total`,
    "Total failed Soroban RPC getEvents calls.",
  );
  const eventsDecoded = registerCounter(
    `${METRICS_PREFIX}events_decoded_total`,
    "Total on-chain events returned by the RPC and passed through the decoder.",
  );
  const eventsSkipped = registerCounter(
    `${METRICS_PREFIX}events_skipped_total`,
    "Total events not notified: unknown type, no formatter, or MAX_NOTIFICATIONS_PER_CYCLE cap.",
  );
  const notificationsSent = registerCounter(
    `${METRICS_PREFIX}notifications_sent_total`,
    "Total Telegram messages successfully sent.",
  );
  const notificationsFailed = registerCounter(
    `${METRICS_PREFIX}notifications_failed_total`,
    "Total Telegram sends that threw an error (cursor still advanced).",
  );
  const staleCursorEvents = registerCounter(
    `${METRICS_PREFIX}stale_cursor_events_total`,
    "Number of times a stale-cursor warning was emitted (events in the gap are lost).",
  );
  const activityAnomalies = registerCounter(
    `${METRICS_PREFIX}activity_anomalies_total`,
    "Complete poll cycles classified as a spike or drop against the rolling activity baseline.",
  );
  const consecutiveFailures = registerGauge(
    `${METRICS_PREFIX}consecutive_failures`,
    "Current number of consecutive full-cycle RPC failures (resets to 0 on any success).",
  );
  const lastCycleEvents = registerGauge(
    `${METRICS_PREFIX}last_cycle_events`,
    "Events observed in the most recent complete poll cycle.",
  );
  const activityBaselineEvents = registerGauge(
    `${METRICS_PREFIX}activity_baseline_events`,
    "Rolling mean events per cycle at the most recent baseline comparison (rounded).",
  );

  function render(): string {
    const lines: string[] = [];

    for (const entry of registered.values()) {
      lines.push(`# HELP ${entry.name} ${escapeHelp(entry.help)}`);
      lines.push(`# TYPE ${entry.name} ${entry.type}`);
      lines.push(`${entry.name} ${entry.handle.value()}`);
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
    registerCounter,
    registerGauge,
    render,
    startServer,
  };
}

export type Metrics = ReturnType<typeof createMetrics>;
