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

// ── Metric types & label escaping ─────────────────────────────────────────────

export type MetricLabelErrorCode =
  | "INVALID_METRIC_NAME"
  | "DUPLICATE_METRIC_NAME"
  | "INVALID_LABEL_KEY"
  | "RESERVED_LABEL_KEY"
  | "UNDECLARED_LABEL_KEY"
  | "MISSING_LABEL_KEY"
  | "NON_STRING_LABEL_VALUE"
  | "CONTROL_CHARACTER_IN_LABEL_VALUE"
  | "NON_STRING_HELP"
  | "CONTROL_CHARACTER_IN_HELP";

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
 * Escape a Prometheus v0.0.4 `# HELP` docstring (`\` -> `\\`, `\n` -> `\n`)
 * while rejecting disallowed C0/DEL/C1 control characters (`\r`, `\0`, `\x1b`, etc.)
 * so help text can never break out of the comment line to inject samples.
 */
export function escapeMetricHelp(help: string): string {
  if (typeof help !== "string") {
    throw new MetricLabelError(
      "NON_STRING_HELP",
      `Prometheus HELP text must be a string; got ${typeof help}`,
    );
  }
  const badMatch = DISALLOWED_LABEL_CONTROL_CHAR_RE.exec(help);
  if (badMatch !== null) {
    const codePoint = badMatch[0].charCodeAt(0);
    const hex = `0x${codePoint.toString(16).padStart(2, "0")}`;
    throw new MetricLabelError(
      "CONTROL_CHARACTER_IN_HELP",
      `Prometheus HELP text contains disallowed control character (${hex})`,
    );
  }
  return help.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
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
  /** Entries currently held in the dead-letter queue (0 when the queue is disabled). */
  deadLetterEntries: Gauge;
  /** Maximum entries the dead-letter queue can hold (0 when the queue is disabled). */
  deadLetterCapacity: Gauge;

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

export function createMetrics(options?: MetricsOptions): MetricsRegistry {
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
  const deadLetterEntries = makeGauge(
    `${METRICS_PREFIX}dead_letter_entries`,
    "Entries currently held in the dead-letter queue (0 when the queue is disabled).",
  );
  const deadLetterCapacity = makeGauge(
    `${METRICS_PREFIX}dead_letter_capacity`,
    "Maximum entries the dead-letter queue can hold (0 when the queue is disabled).",
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
    deadLetterEntries,
    deadLetterCapacity,
  ];

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

  interface LabeledMetricFamily {
    name: string;
    help: string;
    type: "counter" | "gauge";
    labelNames: readonly string[];
    series: Map<string, number>;
  }
  const labeledFamilies: LabeledMetricFamily[] = [];
  const registeredNames = new Set<string>([
    ...counters.map((c) => c._name),
    ...gauges.map((g) => g._name),
  ]);

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
    if (registeredNames.has(validName)) {
      throw new MetricLabelError(
        "DUPLICATE_METRIC_NAME",
        `Prometheus metric family ${JSON.stringify(validName)} is already registered`,
      );
    }
    const escapedHelp = escapeMetricHelp(help);
    const validKeys = labelNames.map((k) => validateMetricLabelKey(k));
    registeredNames.add(validName);
    const family: LabeledMetricFamily = {
      name: validName,
      help: escapedHelp,
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
    if (registeredNames.has(validName)) {
      throw new MetricLabelError(
        "DUPLICATE_METRIC_NAME",
        `Prometheus metric family ${JSON.stringify(validName)} is already registered`,
      );
    }
    const escapedHelp = escapeMetricHelp(help);
    const validKeys = labelNames.map((k) => validateMetricLabelKey(k));
    registeredNames.add(validName);
    const family: LabeledMetricFamily = {
      name: validName,
      help: escapedHelp,
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
    notificationAgeSamples,
    notificationAgeMissingLedgerTime,
    notificationAgeTotalMs,
    lastNotificationAgeMs,
    maxNotificationAgeMs,
    deadLetterEntries,
    deadLetterCapacity,
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