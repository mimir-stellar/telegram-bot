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

import {
  DROPPED_SAMPLE_REASONS,
  DroppedMetricSamplesTracker,
  type DroppedSampleReason,
} from "./stellar/metrics.js";

export { DROPPED_SAMPLE_REASONS, DroppedMetricSamplesTracker, type DroppedSampleReason };

// ── Metric types ──────────────────────────────────────────────────────────────

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

export interface DroppedSamplesMetrics {
  /** Increment the bounded dropped-sample counter for `reason`. */
  inc(reason: DroppedSampleReason, count?: number): void;
  /** Read total dropped samples, or the count for one bounded `reason`. */
  value(reason?: DroppedSampleReason): number;
  /** Snapshot of dropped sample counts keyed by bounded reason. */
  byReason(): Record<DroppedSampleReason, number>;
}

export interface LabeledMetricDefinition {
  name: string;
  help: string;
  labelNames: readonly string[];
  /** Optional bounded allowlists per label key; values outside an allowlist are dropped as `unknown_label`. */
  allowedValues?: Readonly<Record<string, readonly string[]>>;
}

export interface LabeledCounter {
  inc(labels: Readonly<Record<string, string>>, delta?: number): void;
  value(labels: Readonly<Record<string, string>>): number | undefined;
}

export interface LabeledGauge {
  set(labels: Readonly<Record<string, string>>, value: number): void;
  value(labels: Readonly<Record<string, string>>): number | undefined;
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
  /** Bounded counter of rejected metric samples partitioned by reason. */
  droppedSamples: DroppedSamplesMetrics;

  /** Define a counter with declared label names (and optional bounded value allowlists). */
  defineLabeledCounter(definition: LabeledMetricDefinition): LabeledCounter;
  /** Define a gauge with declared label names (and optional bounded value allowlists). */
  defineLabeledGauge(definition: LabeledMetricDefinition): LabeledGauge;
  /**
   * Non-throwing sample ingestion entry point: validates metric name, label set,
   * and numeric finiteness; drops invalid samples and increments `droppedSamples`.
   */
  recordSample(
    metricName: string,
    value: number,
    labels?: Readonly<Record<string, string>>,
  ): boolean;

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

const VALID_METRIC_NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const VALID_LABEL_KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const CONTROL_CHAR_RE = /[\x00-\x08\x0b-\x1f\x7f]/;

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function validateDeclaredLabels(labelNames: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const key of labelNames) {
    if (typeof key !== "string" || !VALID_LABEL_KEY_RE.test(key) || key.startsWith("__")) {
      throw new TypeError(`Invalid Prometheus label key declaration: ${String(key)}`);
    }
    if (seen.has(key)) {
      throw new TypeError(`Duplicate Prometheus label key declaration: ${key}`);
    }
    seen.add(key);
    out.push(key);
  }
  return out;
}

function canonicalizeSampleLabels(
  declaredKeys: readonly string[],
  allowedValues: Readonly<Record<string, readonly string[]>> | undefined,
  labels: unknown,
): string | null {
  if (typeof labels !== "object" || labels === null || Array.isArray(labels)) {
    return declaredKeys.length === 0 ? "" : null;
  }
  const record = labels as Record<string, unknown>;
  const providedKeys = Object.keys(record);
  if (providedKeys.length !== declaredKeys.length) return null;

  const pairs: string[] = [];
  for (const key of declaredKeys) {
    if (!Object.hasOwn(record, key)) return null;
    const rawVal = record[key];
    if (typeof rawVal !== "string" || CONTROL_CHAR_RE.test(rawVal)) return null;
    const allowlist = allowedValues?.[key];
    if (allowlist !== undefined && !allowlist.includes(rawVal)) return null;
    pairs.push(`${key}="${escapeLabelValue(rawVal)}"`);
  }
  return pairs.length > 0 ? `{${pairs.join(",")}}` : "";
}

function makeCounter(
  name: string,
  help: string,
  onDrop: (reason: DroppedSampleReason) => void,
): Counter & { _name: string; _help: string } {
  let _value = 0;
  return {
    _name: name,
    _help: help,
    inc(delta = 1): void {
      if (typeof delta !== "number" || !Number.isFinite(delta)) {
        onDrop("invalid_number");
        return;
      }
      if (delta < 0) {
        onDrop("negative_delta");
        throw new RangeError(`Counter.inc delta must be >= 0; got ${delta}`);
      }
      _value += delta;
    },
    value(): number {
      return _value;
    },
  };
}

function makeGauge(
  name: string,
  help: string,
  onDrop: (reason: DroppedSampleReason) => void,
): Gauge & { _name: string; _help: string } {
  let _value = 0;
  return {
    _name: name,
    _help: help,
    set(value: number): void {
      if (typeof value !== "number" || !Number.isFinite(value)) {
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

interface LabeledSeriesRegistration {
  name: string;
  help: string;
  kind: "counter" | "gauge";
  declaredKeys: string[];
  allowedValues?: Readonly<Record<string, readonly string[]>> | undefined;
  series: Map<string, number>;
}

export function createMetrics(): MetricsRegistry {
  const droppedTracker = new DroppedMetricSamplesTracker();
  const onDrop = (reason: DroppedSampleReason): void => {
    droppedTracker.recordDrop(reason);
  };

  const pollCycles = makeCounter(
    `${METRICS_PREFIX}poll_cycles_total`,
    "Total number of poll cycles started.",
    onDrop,
  );
  const rpcRequests = makeCounter(
    `${METRICS_PREFIX}rpc_requests_total`,
    "Total successful Soroban RPC getEvents calls.",
    onDrop,
  );
  const rpcErrors = makeCounter(
    `${METRICS_PREFIX}rpc_errors_total`,
    "Total failed Soroban RPC getEvents calls.",
    onDrop,
  );
  const eventsDecoded = makeCounter(
    `${METRICS_PREFIX}events_decoded_total`,
    "Total on-chain events returned by the RPC and passed through the decoder.",
    onDrop,
  );
  const eventsSkipped = makeCounter(
    `${METRICS_PREFIX}events_skipped_total`,
    "Total events not notified: unknown type, no formatter, or MAX_NOTIFICATIONS_PER_CYCLE cap.",
    onDrop,
  );
  const notificationsSent = makeCounter(
    `${METRICS_PREFIX}notifications_sent_total`,
    "Total Telegram messages successfully sent.",
    onDrop,
  );
  const notificationsFailed = makeCounter(
    `${METRICS_PREFIX}notifications_failed_total`,
    "Total Telegram sends that threw an error (cursor still advanced).",
    onDrop,
  );
  const staleCursorEvents = makeCounter(
    `${METRICS_PREFIX}stale_cursor_events_total`,
    "Number of times a stale-cursor warning was emitted (events in the gap are lost).",
    onDrop,
  );
  const consecutiveFailures = makeGauge(
    `${METRICS_PREFIX}consecutive_failures`,
    "Current number of consecutive full-cycle RPC failures (resets to 0 on any success).",
    onDrop,
  );
  const lastCycleEvents = makeGauge(
    `${METRICS_PREFIX}last_cycle_events`,
    "Events observed in the most recent complete poll cycle.",
    onDrop,
  );
  const activityBaselineEvents = makeGauge(
    `${METRICS_PREFIX}activity_baseline_events`,
    "Rolling mean events per cycle at the most recent baseline comparison (rounded).",
    onDrop,
  );
  const activityAnomalies = makeCounter(
    `${METRICS_PREFIX}activity_anomalies_total`,
    "Complete poll cycles classified as a spike or drop against the rolling activity baseline.",
    onDrop,
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
  const labeledRegistrations = new Map<string, LabeledSeriesRegistration>();

  const builtinLookup = new Map<
    string,
    { kind: "counter"; target: Counter } | { kind: "gauge"; target: Gauge }
  >([
    ["pollCycles", { kind: "counter", target: pollCycles }],
    [pollCycles._name, { kind: "counter", target: pollCycles }],
    ["rpcRequests", { kind: "counter", target: rpcRequests }],
    [rpcRequests._name, { kind: "counter", target: rpcRequests }],
    ["rpcErrors", { kind: "counter", target: rpcErrors }],
    [rpcErrors._name, { kind: "counter", target: rpcErrors }],
    ["eventsDecoded", { kind: "counter", target: eventsDecoded }],
    [eventsDecoded._name, { kind: "counter", target: eventsDecoded }],
    ["eventsSkipped", { kind: "counter", target: eventsSkipped }],
    [eventsSkipped._name, { kind: "counter", target: eventsSkipped }],
    ["notificationsSent", { kind: "counter", target: notificationsSent }],
    [notificationsSent._name, { kind: "counter", target: notificationsSent }],
    ["notificationsFailed", { kind: "counter", target: notificationsFailed }],
    [notificationsFailed._name, { kind: "counter", target: notificationsFailed }],
    ["staleCursorEvents", { kind: "counter", target: staleCursorEvents }],
    [staleCursorEvents._name, { kind: "counter", target: staleCursorEvents }],
    ["activityAnomalies", { kind: "counter", target: activityAnomalies }],
    [activityAnomalies._name, { kind: "counter", target: activityAnomalies }],
    ["consecutiveFailures", { kind: "gauge", target: consecutiveFailures }],
    [consecutiveFailures._name, { kind: "gauge", target: consecutiveFailures }],
    ["lastCycleEvents", { kind: "gauge", target: lastCycleEvents }],
    [lastCycleEvents._name, { kind: "gauge", target: lastCycleEvents }],
    ["activityBaselineEvents", { kind: "gauge", target: activityBaselineEvents }],
    [activityBaselineEvents._name, { kind: "gauge", target: activityBaselineEvents }],
  ]);

  function ensureLabeledRegistration(
    definition: LabeledMetricDefinition,
    kind: "counter" | "gauge",
  ): LabeledSeriesRegistration {
    if (!VALID_METRIC_NAME_RE.test(definition.name)) {
      throw new TypeError(`Invalid Prometheus metric name: ${definition.name}`);
    }
    const declaredKeys = validateDeclaredLabels(definition.labelNames);
    const existing = labeledRegistrations.get(definition.name);
    if (existing) {
      if (
        existing.kind !== kind ||
        existing.help !== definition.help ||
        existing.declaredKeys.join(",") !== declaredKeys.join(",")
      ) {
        throw new Error(`Conflicting labeled metric registration for ${definition.name}`);
      }
      return existing;
    }
    const reg: LabeledSeriesRegistration = {
      name: definition.name,
      help: definition.help,
      kind,
      declaredKeys,
      allowedValues: definition.allowedValues,
      series: new Map<string, number>(),
    };
    labeledRegistrations.set(definition.name, reg);
    return reg;
  }

  function defineLabeledCounter(definition: LabeledMetricDefinition): LabeledCounter {
    const reg = ensureLabeledRegistration(definition, "counter");
    return {
      inc(labels: Readonly<Record<string, string>>, delta = 1): void {
        const labelBlock = canonicalizeSampleLabels(reg.declaredKeys, reg.allowedValues, labels);
        if (labelBlock === null) {
          onDrop("unknown_label");
          return;
        }
        if (typeof delta !== "number" || !Number.isFinite(delta)) {
          onDrop("invalid_number");
          return;
        }
        if (delta < 0) {
          onDrop("negative_delta");
          throw new RangeError(`LabeledCounter.inc delta must be >= 0; got ${delta}`);
        }
        reg.series.set(labelBlock, (reg.series.get(labelBlock) ?? 0) + delta);
      },
      value(labels: Readonly<Record<string, string>>): number | undefined {
        const labelBlock = canonicalizeSampleLabels(reg.declaredKeys, reg.allowedValues, labels);
        if (labelBlock === null) return undefined;
        return reg.series.get(labelBlock);
      },
    };
  }

  function defineLabeledGauge(definition: LabeledMetricDefinition): LabeledGauge {
    const reg = ensureLabeledRegistration(definition, "gauge");
    return {
      set(labels: Readonly<Record<string, string>>, value: number): void {
        const labelBlock = canonicalizeSampleLabels(reg.declaredKeys, reg.allowedValues, labels);
        if (labelBlock === null) {
          onDrop("unknown_label");
          return;
        }
        if (typeof value !== "number" || !Number.isFinite(value)) {
          onDrop("invalid_number");
          return;
        }
        reg.series.set(labelBlock, value);
      },
      value(labels: Readonly<Record<string, string>>): number | undefined {
        const labelBlock = canonicalizeSampleLabels(reg.declaredKeys, reg.allowedValues, labels);
        if (labelBlock === null) return undefined;
        return reg.series.get(labelBlock);
      },
    };
  }

  function recordSample(
    metricName: string,
    value: number,
    labels?: Readonly<Record<string, string>>,
  ): boolean {
    const builtin = builtinLookup.get(metricName);
    if (builtin) {
      if (labels !== undefined && Object.keys(labels).length > 0) {
        onDrop("unknown_label");
        return false;
      }
      if (typeof value !== "number" || !Number.isFinite(value)) {
        onDrop("invalid_number");
        return false;
      }
      if (builtin.kind === "counter") {
        if (value < 0) {
          onDrop("negative_delta");
          return false;
        }
        builtin.target.inc(value);
      } else {
        builtin.target.set(value);
      }
      return true;
    }

    const labeled = labeledRegistrations.get(metricName);
    if (!labeled) {
      onDrop("unknown_metric");
      return false;
    }
    const labelBlock = canonicalizeSampleLabels(
      labeled.declaredKeys,
      labeled.allowedValues,
      labels ?? {},
    );
    if (labelBlock === null) {
      onDrop("unknown_label");
      return false;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      onDrop("invalid_number");
      return false;
    }
    if (labeled.kind === "counter") {
      if (value < 0) {
        onDrop("negative_delta");
        return false;
      }
      labeled.series.set(labelBlock, (labeled.series.get(labelBlock) ?? 0) + value);
    } else {
      labeled.series.set(labelBlock, value);
    }
    return true;
  }

  function render(): string {
    const lines: string[] = [];

    for (const c of counters) {
      const val = c.value();
      if (!Number.isFinite(val)) {
        onDrop("invalid_number");
        continue;
      }
      lines.push(`# HELP ${c._name} ${c._help}`);
      lines.push(`# TYPE ${c._name} counter`);
      lines.push(`${c._name} ${val}`);
    }

    for (const g of gauges) {
      const val = g.value();
      if (!Number.isFinite(val)) {
        onDrop("invalid_number");
        continue;
      }
      lines.push(`# HELP ${g._name} ${g._help}`);
      lines.push(`# TYPE ${g._name} gauge`);
      lines.push(`${g._name} ${val}`);
    }

    for (const reg of labeledRegistrations.values()) {
      const finiteLines: string[] = [];
      for (const [labelBlock, val] of reg.series.entries()) {
        if (!Number.isFinite(val)) {
          onDrop("invalid_number");
          continue;
        }
        finiteLines.push(`${reg.name}${labelBlock} ${val}`);
      }
      if (finiteLines.length > 0) {
        lines.push(`# HELP ${reg.name} ${reg.help}`);
        lines.push(`# TYPE ${reg.name} ${reg.kind}`);
        lines.push(...finiteLines);
      }
    }

    lines.push(
      ...droppedTracker.renderPrometheusLines(
        `${METRICS_PREFIX}dropped_metric_samples_total`,
        "Total metric samples dropped before exposition by bounded reason.",
      ),
    );

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
    droppedSamples: {
      inc: (reason, count) => droppedTracker.recordDrop(reason, count),
      value: (reason) => droppedTracker.value(reason),
      byReason: () => droppedTracker.byReason(),
    },
    defineLabeledCounter,
    defineLabeledGauge,
    recordSample,
    render,
    startServer,
  };
}

export type Metrics = ReturnType<typeof createMetrics>;
