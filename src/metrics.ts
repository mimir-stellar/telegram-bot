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

// ── Metric types & label escaping ─────────────────────────────────────────────

export type MetricLabelErrorCode =
  | "INVALID_METRIC_NAME"
  | "INVALID_LABEL_KEY"
  | "RESERVED_LABEL_KEY"
  | "UNDECLARED_LABEL_KEY"
  | "MISSING_LABEL_KEY"
  | "NON_STRING_LABEL_VALUE"
  | "CONTROL_CHARACTER_IN_LABEL_VALUE";

/** Thrown when a metric name, label key, or label value violates exposition safety rules. */
export class MetricLabelError extends Error {
  readonly code: MetricLabelErrorCode;

  constructor(code: MetricLabelErrorCode, message: string) {
    super(message);
    this.name = "MetricLabelError";
    this.code = code;
  }
}

const PROMETHEUS_METRIC_NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const PROMETHEUS_LABEL_KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
/**
 * Disallowed ASCII C0, DEL, and C1 control characters in Prometheus label
 * values. Line feed (`\n`, 0x0a) is the sole control character with a valid
 * Prometheus v0.0.4 escape sequence (`\n`); all others (`\0`, `\r`, `\t`, ESC
 * `\x1b`, BEL, DEL, C1 CSI `\x9b`, etc.) are rejected to prevent line-splitting
 * and terminal/protocol control-character injection.
 */
const DISALLOWED_LABEL_CONTROL_CHAR_RE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;

/** Validate a Prometheus metric name before registration or exposition. */
export function validateMetricName(name: string): string {
  if (typeof name !== "string" || !PROMETHEUS_METRIC_NAME_RE.test(name)) {
    throw new MetricLabelError(
      "INVALID_METRIC_NAME",
      `Invalid Prometheus metric name: ${JSON.stringify(name)}`,
    );
  }
  return name;
}

/**
 * Validate a Prometheus label key before exposition.
 * Rejects empty keys, reserved `__*` prefixes, punctuation, whitespace, and control characters.
 */
export function validateMetricLabelKey(key: string): string {
  if (typeof key !== "string" || !PROMETHEUS_LABEL_KEY_RE.test(key)) {
    throw new MetricLabelError(
      "INVALID_LABEL_KEY",
      `Invalid Prometheus label key: ${JSON.stringify(key)}`,
    );
  }
  if (key.startsWith("__")) {
    throw new MetricLabelError(
      "RESERVED_LABEL_KEY",
      `Prometheus label key ${JSON.stringify(key)} uses reserved "__" prefix`,
    );
  }
  return key;
}

/**
 * Escape a Prometheus v0.0.4 label value (`\` -> `\\`, `"` -> `\"`, `\n` -> `\n`)
 * while rejecting disallowed C0/DEL/C1 control characters (`\r`, `\0`, `\x1b`, etc.).
 */
export function escapeMetricLabelValue(value: string): string {
  if (typeof value !== "string") {
    throw new MetricLabelError(
      "NON_STRING_LABEL_VALUE",
      `Prometheus label value must be a string; got ${typeof value}`,
    );
  }
  const badMatch = DISALLOWED_LABEL_CONTROL_CHAR_RE.exec(value);
  if (badMatch !== null) {
    const codePoint = badMatch[0].charCodeAt(0);
    const hex = `0x${codePoint.toString(16).padStart(2, "0")}`;
    throw new MetricLabelError(
      "CONTROL_CHARACTER_IN_LABEL_VALUE",
      `Prometheus label value contains disallowed control character (${hex})`,
    );
  }
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
}

/**
 * Validate all label keys and escape all label values into a Prometheus
 * `{k1="v1",k2="v2"}` block (or `""` when `labels` is empty/undefined).
 */
export function formatMetricLabels(labels?: Readonly<Record<string, string>>): string {
  if (!labels) return "";
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  const parts: string[] = [];
  for (const [rawKey, rawValue] of entries) {
    const key = validateMetricLabelKey(rawKey);
    const escapedValue = escapeMetricLabelValue(rawValue);
    parts.push(`${key}="${escapedValue}"`);
  }
  return `{${parts.join(",")}}`;
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

export interface LabeledCounter {
  /** Increment labeled series by 1 (default) or `delta` (must be ≥ 0). */
  inc(labels: Readonly<Record<string, string>>, delta?: number): void;
  /** Read current value for `labels` (`0` before first observation). */
  value(labels: Readonly<Record<string, string>>): number;
}

export interface LabeledGauge {
  /** Set labeled series to `value`. */
  set(labels: Readonly<Record<string, string>>, value: number): void;
  /** Read current value for `labels` (`0` before first observation). */
  value(labels: Readonly<Record<string, string>>): number;
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

  /** Register a custom counter with validated Prometheus label keys. */
  registerLabeledCounter(
    name: string,
    help: string,
    labelNames: readonly string[],
  ): LabeledCounter;

  /** Register a custom gauge with validated Prometheus label keys. */
  registerLabeledGauge(
    name: string,
    help: string,
    labelNames: readonly string[],
  ): LabeledGauge;

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

function makeGauge(name: string, help: string): Gauge & { _name: string; _help: string } {
  let _value = 0;
  return {
    _name: name,
    _help: help,
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

  const counters = [
    pollCycles,
    rpcRequests,
    rpcErrors,
    eventsDecoded,
    eventsSkipped,
    notificationsSent,
    notificationsFailed,
    staleCursorEvents,
    activityAnomalies,
  ];
  const gauges = [consecutiveFailures, lastCycleEvents, activityBaselineEvents];

  interface LabeledMetricFamily {
    name: string;
    help: string;
    type: "counter" | "gauge";
    labelNames: readonly string[];
    series: Map<string, number>;
  }
  const labeledFamilies: LabeledMetricFamily[] = [];

  function canonicalizeDeclaredLabels(
    declared: readonly string[],
    labels: Readonly<Record<string, string>>,
  ): string {
    if (!labels || typeof labels !== "object" || Array.isArray(labels)) {
      throw new MetricLabelError("INVALID_LABEL_KEY", "Labels must be a plain object");
    }
    const providedKeys = Object.keys(labels);
    for (const k of providedKeys) {
      validateMetricLabelKey(k);
      if (!declared.includes(k)) {
        throw new MetricLabelError(
          "UNDECLARED_LABEL_KEY",
          `Undeclared label key ${JSON.stringify(k)} (expected: ${declared.join(", ")})`,
        );
      }
    }
    const ordered: Record<string, string> = {};
    for (const key of declared) {
      if (!Object.prototype.hasOwnProperty.call(labels, key)) {
        throw new MetricLabelError(
          "MISSING_LABEL_KEY",
          `Missing required label key ${JSON.stringify(key)}`,
        );
      }
      ordered[key] = labels[key]!;
    }
    return formatMetricLabels(ordered);
  }

  function registerLabeledCounter(
    name: string,
    help: string,
    labelNames: readonly string[],
  ): LabeledCounter {
    const validName = validateMetricName(name);
    const validKeys = labelNames.map((k) => validateMetricLabelKey(k));
    const family: LabeledMetricFamily = {
      name: validName,
      help,
      type: "counter",
      labelNames: validKeys,
      series: new Map(),
    };
    labeledFamilies.push(family);
    return {
      inc(labels, delta = 1): void {
        if (delta < 0 || !Number.isFinite(delta)) {
          throw new RangeError(`Counter.inc delta must be a finite number >= 0; got ${delta}`);
        }
        const renderedLabels = canonicalizeDeclaredLabels(validKeys, labels);
        family.series.set(renderedLabels, (family.series.get(renderedLabels) ?? 0) + delta);
      },
      value(labels): number {
        const renderedLabels = canonicalizeDeclaredLabels(validKeys, labels);
        return family.series.get(renderedLabels) ?? 0;
      },
    };
  }

  function registerLabeledGauge(
    name: string,
    help: string,
    labelNames: readonly string[],
  ): LabeledGauge {
    const validName = validateMetricName(name);
    const validKeys = labelNames.map((k) => validateMetricLabelKey(k));
    const family: LabeledMetricFamily = {
      name: validName,
      help,
      type: "gauge",
      labelNames: validKeys,
      series: new Map(),
    };
    labeledFamilies.push(family);
    return {
      set(labels, value): void {
        if (!Number.isFinite(value)) {
          throw new RangeError(`Gauge.set value must be finite; got ${value}`);
        }
        const renderedLabels = canonicalizeDeclaredLabels(validKeys, labels);
        family.series.set(renderedLabels, value);
      },
      value(labels): number {
        const renderedLabels = canonicalizeDeclaredLabels(validKeys, labels);
        return family.series.get(renderedLabels) ?? 0;
      },
    };
  }

  function render(): string {
    const lines: string[] = [];

    for (const c of counters) {
      lines.push(`# HELP ${c._name} ${c._help}`);
      lines.push(`# TYPE ${c._name} counter`);
      lines.push(`${c._name} ${c.value()}`);
    }

    for (const g of gauges) {
      lines.push(`# HELP ${g._name} ${g._help}`);
      lines.push(`# TYPE ${g._name} gauge`);
      lines.push(`${g._name} ${g.value()}`);
    }

    for (const family of labeledFamilies) {
      if (family.series.size === 0) continue;
      lines.push(`# HELP ${family.name} ${family.help}`);
      lines.push(`# TYPE ${family.name} ${family.type}`);
      for (const [renderedLabels, val] of family.series.entries()) {
        lines.push(`${family.name}${renderedLabels} ${val}`);
      }
    }

    // Prometheus text format requires a trailing newline.
    return lines.join("\n") + "\n";
  }

  function handleRequest(req: IncomingMessage, res: ServerResponse): void {
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

    res.writeHead(404, {
      "Content-Type": "text/plain",
      "Cache-Control": "no-store",
    });
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
    registerLabeledCounter,
    registerLabeledGauge,
    render,
    startServer,
  };
}

export type Metrics = ReturnType<typeof createMetrics>;
