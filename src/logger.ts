/**
 * Bounded in-memory log capture for operators, plus the `/export` message.
 *
 * ── Why capture at all ───────────────────────────────────────────────────────
 *
 * When this notifier misbehaves the operator usually has exactly two vantage
 * points: `/status` (which reports state, not history) and the process log on
 * the host (which an operator of a hosted deployment may not be able to see).
 * A bounded ring of the bot's own recent console lines, requestable from the
 * chat itself, closes that gap without adding a log shipper or a file sink.
 *
 * ── Safety properties (the whole point) ──────────────────────────────────────
 *
 *  - Capture is REDACT-FIRST: `attachConsole()` wraps console so a line is
 *    redacted BEFORE it is stored. A secret that reaches the buffer at all is
 *    a bug (and `renderLogExport` redacts again as a final net).
 *  - The buffer is a fixed-size ring (`LOG_BUFFER_LINES`, default 500, `0`
 *    disables). Nothing unbounded is ever retained — not remote payloads, not
 *    full explorer URLs, not per-line timestamps beyond relative ages.
 *  - Redaction never invents output: it masks substrings, so a line either
 *    contains the placeholder or the original text, never a mix beyond that.
 *  - The export is plain text with NO MarkdownV2 parse mode, so arbitrary
 *    log content can never break message formatting or inject entities.
 *  - The export includes a summary + counters + redacted logs and is
 *    hard-capped again at send time (`MAX_EXPORT_CHARS`).
 *
 * What is deliberately NOT here: writing log files, shipping logs anywhere,
 * or holding anything richer than the lines the bot already printed.
 */

import { createReadStream } from "node:fs";
import { StringDecoder } from "node:string_decoder";

import { networkLabel, type BotConfig } from "./config.js";
import type { PollerStatus } from "./poller.js";
import { redactText } from "./redact.js";

/** Placeholder substituted for every redacted span. */
export const REDACTED = "●●●";

/** Hard cap on the rendered export, independent of the ring size. */
export const MAX_EXPORT_CHARS = 32_000;

/** One captured console line, normalized to a level and a redacted string. */
export interface LogLine {
  /** Monotonic capture sequence, for ordering after ring wraparound. */
  seq: number;
  /** `Date.now()` at capture, so ages can be shown without storing ISO text. */
  at: number;
  level: "log" | "info" | "warn" | "error";
  text: string;
}

export interface LogCapture {
  /** Redact and append one line. Drops the oldest when the ring is full. */
  add(level: LogLine["level"], text: string): void;
  /** Recent lines, oldest first. */
  lines(): LogLine[];
  /** Number of lines currently held (≤ configured capacity). */
  size(): number;
  /** Configured capacity (0 = capture disabled). */
  capacity(): number;
}

/**
 * Redact secrets from one log line before it can be stored or shown.
 *
 * Order matters: the literal bot token is masked first (it is the most
 * dangerous and the most likely to appear verbatim in a rejected-URL error),
 * then the chat id, then any full-precision account/contract strkey (those
 * are public on-chain data, but a full id in a pasted log is more identifying
 * than it needs to be).
 */
export function redactLine(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join(REDACTED);
  }
  // Full-precision Stellar strkeys (G…/C…, 56 chars) -> first 4 + … + last 4.
  // Shortened display forms like `CDV6…LPKZI` are left alone; the ellipsis
  // means there is nothing more to hide.
  out = out.replace(/\b[GC][A-Z2-7]{55}\b/g, (m) => `${m.slice(0, 4)}…${m.slice(-4)}`);
  return out;
}

/** Derive the literal substrings that must never survive into the buffer. */
export function secretsFor(config: BotConfig): string[] {
  return [config.botToken, config.chatId].filter((s) => s.length > 0);
}

/**
 * Create the ring buffer. Capacity 0 means capture is disabled: `add` is a
 * no-op and `lines()` is always empty, so callers need no special casing.
 */
export function createLogCapture(capacity: number): LogCapture {
  const cap = Math.max(0, Math.floor(capacity));
  const ring: LogLine[] = [];
  let nextSeq = 0;

  return {
    add(level, text) {
      if (cap === 0) return;
      const line: LogLine = { seq: nextSeq++, at: Date.now(), level, text };
      if (ring.length >= cap) ring.shift();
      ring.push(line);
    },
    lines() {
      return [...ring];
    },
    size() {
      return ring.length;
    },
    capacity() {
      return cap;
    },
  };
}

/**
 * Wrap console.log/info/warn/error so every line the bot prints is captured
 * (already redacted). Returns a restore function so tests can unwire.
 *
 * Note: this only sees `console.*` output, which is the only logging this bot
 * does. Library chatter (e.g. grammy internals) that bypasses console is not
 * captured — acceptable for a notifier whose own lines carry the story.
 */
export function attachConsole(capture: LogCapture, secrets: string[]): () => void {
  const methods = ["log", "info", "warn", "error"] as const;
  type LogFn = (...args: unknown[]) => void;
  const originals = new Map<string, LogFn>();

  for (const level of methods) {
    const original = console[level] as LogFn;
    originals.set(level, original);
    console[level] = (...args: unknown[]) => {
      // Original first: the host's own output stays untouched even if the
      // capture below throws (it must never take down the real log call).
      original(...args);
      try {
        capture.add(level, redactLine(args.map(String).join(" "), secrets));
      } catch {
        // Capture is best-effort by contract.
      }
    };
  }

  return () => {
    for (const level of methods) {
      const original = originals.get(level);
      if (original) console[level] = original;
    }
  };
}

function agoShort(timestamp: number, now: number): string {
  const s = Math.max(0, Math.round((now - timestamp) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

/**
 * Render the operator export: a state summary plus the redacted recent logs.
 *
 * Plain text on purpose — it is sent without a parse mode, so nothing in the
 * log content can affect formatting, and no credential or payment amount
 * beyond what `/status` already shows is included.
 */
export function renderLogExport(
  config: BotConfig,
  status: PollerStatus,
  capture: LogCapture,
  now: number = Date.now(),
): string {
  const lines: string[] = [];
  // The version is public build metadata (also on /health), not a secret.
  lines.push(`Mimir notifier log export · v${config.version ?? "unknown"}`);
  // Network label is display-safe (testnet/public/custom) — not the RPC URL,
  // which could name a private endpoint.
  lines.push(`network: ${networkLabel(config)} · log lines kept: ${capture.capacity()}`);
  lines.push(
    `running: ${status.running ? "yes" : "no"} · cycles: ${status.cycles} · ` +
      `sent: ${status.notificationsSent} · failed sends: ${status.notificationsFailed} · ` +
      `skipped: ${status.eventsSkipped} · consecutive failures: ${status.consecutiveFailures}`,
  );
  lines.push(
    `last poll: ${status.lastPollAt ? agoShort(status.lastPollAt, now) : "never"} · ` +
      `last success: ${status.lastSuccessAt ? agoShort(status.lastSuccessAt, now) : "never"}`,
  );
  if (status.lastError) {
    lines.push(`last error (${agoShort(status.lastError.at, now)} ago): ${status.lastError.message}`);
  }
  lines.push("");
  lines.push(`recent logs (${capture.size()} lines, redacted):`);

  const logs = capture.lines();
  if (logs.length === 0) {
    lines.push("(no log lines captured)");
  }
  for (const line of logs) {
    lines.push(`+${agoShort(line.at, now)} [${line.level}] ${line.text}`);
  }

  let text = lines.join("\n");
  // Final safety net: the summary interpolates poller state (last error
  // messages can quote a rejected API URL, which may embed the token). One
  // redaction pass over the whole render guarantees the export is clean even
  // if a future call site forgets.
  text = redactLine(text, secretsFor(config));
  if (text.length > MAX_EXPORT_CHARS) {
    // Keep the summary (the head) and the newest logs (the tail of `lines`).
    // Trim from the middle of the rendered text: the head is the summary, the
    // tail is the most recent log lines.
    const head = text.slice(0, 2_000);
    const tailBudget = MAX_EXPORT_CHARS - head.length - 40;
    const tail = text.slice(text.length - tailBudget);
    text = `${head}\n…[older log lines omitted]…\n${tail}`;
  }
  return text;
}

// ── Structured logger ─────────────────────────────────────────────────────────
//
// `Logger` keeps the plain console lines operators already grep for (text, the
// default) and can emit one JSON object per line instead (`LOG_FORMAT=json`).
// Every line is redacted before it leaves the process: registered secrets and
// anything shaped like a Telegram bot token are replaced, in the message and in
// every field. Field values are bounded (depth, string length) so a remote
// payload can never turn one log call into an unbounded record, and a field
// that cannot be serialized degrades to the bare message instead of throwing.

export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";
export type LogFormat = "text" | "json";
export type LogFields = Record<string, unknown>;
export type LogSink = (level: LogLevel, line: string) => void;

export const LOG_LEVEL_ENV = "LOG_LEVEL";
export const LOG_FORMAT_ENV = "LOG_FORMAT";
export const DEFAULT_LOG_LEVEL: LogLevel = "info";
export const DEFAULT_LOG_FORMAT: LogFormat = "text";
/** Every accepted LOG_LEVEL value, lowest severity first. */
export const LOG_LEVELS: readonly LogLevel[] = Object.freeze(["debug", "info", "warn", "error", "fatal"]);
/** Every accepted LOG_FORMAT value. */
export const LOG_FORMATS: readonly LogFormat[] = Object.freeze(["text", "json"]);
/** Longest string any single field may carry into a JSON record. */
export const MAX_LOG_FIELD_CHARS = 1_000;

const LOG_REDACTED = "[REDACTED]";
const MAX_FIELD_DEPTH = 4;
const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 };
const TELEGRAM_TOKEN_SHAPE = /\b\d{5,}:[A-Za-z0-9_-]{20,}/g;

export function parseLogLevel(value: unknown): LogLevel {
  if (typeof value !== "string") return DEFAULT_LOG_LEVEL;
  const normalized = value.trim().toLowerCase();
  return normalized in LEVEL_RANK ? (normalized as LogLevel) : DEFAULT_LOG_LEVEL;
}

export function parseLogFormat(value: unknown): LogFormat {
  if (typeof value !== "string") return DEFAULT_LOG_FORMAT;
  return value.trim().toLowerCase() === "json" ? "json" : DEFAULT_LOG_FORMAT;
}

const consoleSink: LogSink = (level, line) => {
  if (level === "error" || level === "fatal") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};

interface LoggerState {
  level: LogLevel;
  format: LogFormat;
  sink: LogSink;
  secrets: string[];
  now: () => Date;
}

function defaultState(): LoggerState {
  return {
    level: DEFAULT_LOG_LEVEL,
    format: DEFAULT_LOG_FORMAT,
    sink: consoleSink,
    secrets: [],
    now: () => new Date(),
  };
}

let state = defaultState();

function redactLogText(text: string): string {
  let out = text;
  for (const secret of state.secrets) {
    if (secret.length > 0) out = out.split(secret).join(LOG_REDACTED);
  }
  return out.replace(TELEGRAM_TOKEN_SHAPE, LOG_REDACTED);
}

function boundField(text: string): string {
  return text.length <= MAX_LOG_FIELD_CHARS ? text : `${text.slice(0, MAX_LOG_FIELD_CHARS - 1)}…`;
}

function sanitize(value: unknown, depth: number): unknown {
  if (typeof value === "string") return boundField(redactLogText(value));
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_FIELD_DEPTH) return "[depth-limit]";
  if (Array.isArray(value)) return value.map((item) => sanitize(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined || typeof item === "function") continue;
    out[key] = sanitize(item, depth + 1);
  }
  return out;
}

function emit(level: LogLevel, component: string, message: string, fields?: LogFields): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[state.level]) return;
  const msg = redactLogText(message);
  if (state.format === "text") {
    state.sink(level, msg);
    return;
  }
  let line: string;
  try {
    const safe: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(fields ?? {})) {
      if (item === undefined || typeof item === "function") continue;
      safe[key] = sanitize(item, 0);
    }
    line = JSON.stringify({ ...safe, ts: state.now().toISOString(), level, component, msg });
  } catch {
    // Never let a hostile field take the log call (or the caller) down.
    line = msg;
  }
  state.sink(level, line);
}

export const Logger = {
  configure(options: Partial<LoggerState>): void {
    state = { ...state, ...options };
  },
  configureFromEnv(env: Record<string, string | undefined> = process.env): void {
    state = {
      ...state,
      level: parseLogLevel(env[LOG_LEVEL_ENV]),
      format: parseLogFormat(env[LOG_FORMAT_ENV]),
    };
  },
  reset(): void {
    state = defaultState();
  },
  getLevel(): LogLevel {
    return state.level;
  },
  getFormat(): LogFormat {
    return state.format;
  },
  debug(component: string, message: string, fields?: LogFields): void {
    emit("debug", component, message, fields);
  },
  info(component: string, message: string, fields?: LogFields): void {
    emit("info", component, message, fields);
  },
  warn(component: string, message: string, fields?: LogFields): void {
    emit("warn", component, message, fields);
  },
  error(component: string, message: string, fields?: LogFields): void {
    emit("error", component, message, fields);
  },
  fatal(component: string, message: string, fields?: LogFields): void {
    emit("fatal", component, message, fields);
  },
};

// ── Incident timeline export from redacted structured logs ───────────────────
//
// Reads newline-delimited JSON structured logs incrementally in bounded chunks,
// filters by a bounded [from, to] time window and optional correlation ID,
// scrubs secrets through `redact.ts`, retains at most `maxEntries` records in
// deterministic (timestamp, line) order, and renders deterministic text or JSON
// without ever buffering an unbounded file or oversized line in memory.

/** Maximum allowed incident timeline query window (24 hours). */
export const MAX_INCIDENT_TIMELINE_WINDOW_MS = 24 * 60 * 60 * 1_000;

/** Default number of matching entries retained in a timeline export. */
export const DEFAULT_INCIDENT_TIMELINE_MAX_ENTRIES = 500;

/** Hard upper bound on retained timeline entries per export. */
export const MAX_INCIDENT_TIMELINE_ENTRIES = 5_000;

/** Maximum character length of a single raw JSONL line before it is skipped. */
export const MAX_INCIDENT_TIMELINE_LINE_CHARS = 65_536;

const TIMELINE_READ_CHUNK_BYTES = 64 * 1024;
const MSG_CORRELATION_RE = /\bcorrelation=([^\s,;]+)/;

export type IncidentTimelineInput =
  | string
  | Iterable<string | Uint8Array>
  | AsyncIterable<string | Uint8Array>;

export interface IncidentTimelineOptions {
  /** Inclusive window start (ISO-8601 string, Date, or unix epoch ms). */
  from: string | number | Date;
  /** Inclusive window end (ISO-8601 string, Date, or unix epoch ms). */
  to: string | number | Date;
  /** Optional correlation ID to match (`correlationId`, `correlation`, or `correlation=…` in `msg`). */
  correlationId?: string;
  /** Optional tighter window bound in ms (must be > 0 and <= MAX_INCIDENT_TIMELINE_WINDOW_MS). */
  maxWindowMs?: number;
  /** Maximum retained entries (clamped to 1..MAX_INCIDENT_TIMELINE_ENTRIES). */
  maxEntries?: number;
  /** Maximum characters buffered for a single JSONL line before discarding it. */
  maxLineChars?: number;
  /** Optional byte budget on scanned input; stops streaming cleanly when reached. */
  maxScanBytes?: number;
  /** Extra secret strings to redact in addition to registered/Logger secrets. */
  secrets?: readonly string[];
}

export interface IncidentTimelineEntry {
  ts: string;
  tsMs: number;
  line: number;
  level: LogLevel;
  component: string;
  msg: string;
  correlationId: string | null;
  action?: string;
  source?: string;
  ledger?: number;
  eventId?: string;
  error?: string;
  fields: Record<string, unknown>;
}

export interface IncidentTimelineStats {
  scannedLines: number;
  scannedBytes: number;
  matchedEntries: number;
  exportedEntries: number;
  droppedEntries: number;
  malformedLines: number;
  oversizedLines: number;
  truncated: boolean;
}

export interface IncidentTimelineReport {
  window: {
    from: string;
    to: string;
    durationMs: number;
  };
  correlationId: string | null;
  entries: IncidentTimelineEntry[];
  stats: IncidentTimelineStats;
}

function parseTimelineTimestamp(value: string | number | Date, label: string): number {
  if (value instanceof Date) {
    const ms = value.getTime();
    if (!Number.isFinite(ms) || ms < 0) {
      throw new RangeError(`invalid incident timeline '${label}' timestamp`);
    }
    return ms;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`invalid incident timeline '${label}' timestamp`);
    }
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new RangeError(`invalid incident timeline '${label}' timestamp`);
    }
    const parsed = Date.parse(trimmed);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new RangeError(`invalid incident timeline '${label}' timestamp`);
    }
    return parsed;
  }
  throw new RangeError(`invalid incident timeline '${label}' timestamp`);
}

function redactTimelineString(
  value: string,
  secrets: readonly string[],
  maxLen: number = MAX_LOG_FIELD_CHARS,
): string {
  const step1 = redactText(value, { secrets, maxLen: maxLen + 64 });
  const step2 = step1.replace(TELEGRAM_TOKEN_SHAPE, LOG_REDACTED);
  return step2.length <= maxLen ? step2 : `${step2.slice(0, Math.max(0, maxLen - 1))}…`;
}

function sanitizeTimelineField(
  value: unknown,
  secrets: readonly string[],
  depth: number,
): unknown {
  if (typeof value === "string") {
    return redactTimelineString(value, secrets, MAX_LOG_FIELD_CHARS);
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_FIELD_DEPTH) return "[depth-limit]";
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeTimelineField(item, secrets, depth + 1));
  }
  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const out: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    const item = obj[key];
    if (item === undefined || typeof item === "function") continue;
    out[key] = sanitizeTimelineField(item, secrets, depth + 1);
  }
  return out;
}

function extractRawCorrelationId(record: Record<string, unknown>, rawMsg: string): string | null {
  if (typeof record.correlationId === "string" && record.correlationId.trim().length > 0) {
    return record.correlationId.trim();
  }
  if (typeof record.correlation === "string" && record.correlation.trim().length > 0) {
    return record.correlation.trim();
  }
  const match = MSG_CORRELATION_RE.exec(rawMsg);
  if (match && match[1]) {
    return match[1];
  }
  return null;
}

function compareTimelineEntries(a: IncidentTimelineEntry, b: IncidentTimelineEntry): number {
  if (a.tsMs !== b.tsMs) return a.tsMs - b.tsMs;
  return a.line - b.line;
}

function insertBoundedTimelineEntry(
  kept: IncidentTimelineEntry[],
  candidate: IncidentTimelineEntry,
  maxEntries: number,
): boolean {
  if (kept.length < maxEntries) {
    kept.push(candidate);
    return false;
  }
  // Find the chronologically earliest retained entry (`minIdx`). Keep the
  // newest `maxEntries` records deterministically regardless of arrival order.
  let minIdx = 0;
  for (let i = 1; i < kept.length; i += 1) {
    if (compareTimelineEntries(kept[i]!, kept[minIdx]!) < 0) {
      minIdx = i;
    }
  }
  if (compareTimelineEntries(candidate, kept[minIdx]!) > 0) {
    kept[minIdx] = candidate;
  }
  return true;
}

function isKnownLogLevel(value: string): value is LogLevel {
  return value in LEVEL_RANK;
}

/**
 * Stream structured JSONL logs from a file path or chunked iterable, filter by
 * a bounded `[from, to]` time range and optional `correlationId`, and produce a
 * redacted, deterministically ordered incident timeline without loading an
 * unbounded file into memory.
 */
export async function exportIncidentTimeline(
  input: IncidentTimelineInput,
  options: IncidentTimelineOptions,
): Promise<IncidentTimelineReport> {
  const fromMs = parseTimelineTimestamp(options.from, "from");
  const toMs = parseTimelineTimestamp(options.to, "to");
  if (fromMs > toMs) {
    throw new RangeError("incident timeline 'from' timestamp must be <= 'to' timestamp");
  }

  const maxWindowMs = options.maxWindowMs ?? MAX_INCIDENT_TIMELINE_WINDOW_MS;
  if (
    typeof maxWindowMs !== "number" ||
    !Number.isFinite(maxWindowMs) ||
    maxWindowMs <= 0 ||
    maxWindowMs > MAX_INCIDENT_TIMELINE_WINDOW_MS
  ) {
    throw new RangeError(
      `incident timeline maxWindowMs must be in 1..${MAX_INCIDENT_TIMELINE_WINDOW_MS}`,
    );
  }
  const durationMs = toMs - fromMs;
  if (durationMs > maxWindowMs) {
    throw new RangeError(
      `incident timeline window (${durationMs}ms) exceeds maximum bound (${maxWindowMs}ms)`,
    );
  }

  let filterCorrelationId: string | null = null;
  if (options.correlationId !== undefined) {
    if (typeof options.correlationId !== "string") {
      throw new RangeError("incident timeline correlationId must be a non-empty string");
    }
    const trimmed = options.correlationId.trim();
    if (trimmed.length === 0 || trimmed.length > 256) {
      throw new RangeError("incident timeline correlationId must be 1..256 characters");
    }
    filterCorrelationId = trimmed;
  }

  const rawMaxEntries = options.maxEntries ?? DEFAULT_INCIDENT_TIMELINE_MAX_ENTRIES;
  if (typeof rawMaxEntries !== "number" || !Number.isFinite(rawMaxEntries) || rawMaxEntries < 1) {
    throw new RangeError("incident timeline maxEntries must be a positive number");
  }
  const maxEntries = Math.min(MAX_INCIDENT_TIMELINE_ENTRIES, Math.floor(rawMaxEntries));

  const maxLineChars =
    options.maxLineChars !== undefined
      ? Math.max(256, Math.floor(options.maxLineChars))
      : MAX_INCIDENT_TIMELINE_LINE_CHARS;

  const maxScanBytes = options.maxScanBytes;
  if (maxScanBytes !== undefined && (!Number.isFinite(maxScanBytes) || maxScanBytes <= 0)) {
    throw new RangeError("incident timeline maxScanBytes must be a positive number");
  }

  const secrets = [...state.secrets, ...(options.secrets ?? [])].filter(
    (s) => typeof s === "string" && s.length > 0,
  );

  const chunks: Iterable<string | Uint8Array> | AsyncIterable<string | Uint8Array> =
    typeof input === "string"
      ? createReadStream(input, { highWaterMark: TIMELINE_READ_CHUNK_BYTES })
      : input;

  const decoder = new StringDecoder("utf8");
  const kept: IncidentTimelineEntry[] = [];
  let scannedLines = 0;
  let scannedBytes = 0;
  let matchedEntries = 0;
  let droppedEntries = 0;
  let malformedLines = 0;
  let oversizedLines = 0;
  let scanByteLimitHit = false;
  let partialLine = "";
  let discardingCurrentLine = false;

  const processCompletedLine = (rawLine: string, lineNumber: number): void => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const trimmed = line.trim();
    if (trimmed.length === 0) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      malformedLines += 1;
      return;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      malformedLines += 1;
      return;
    }

    const record = parsed as Record<string, unknown>;
    if (
      typeof record.ts !== "string" ||
      typeof record.level !== "string" ||
      typeof record.component !== "string" ||
      typeof record.msg !== "string"
    ) {
      malformedLines += 1;
      return;
    }

    const normalizedLevel = record.level.trim().toLowerCase();
    if (!isKnownLogLevel(normalizedLevel)) {
      malformedLines += 1;
      return;
    }

    const tsMs = Date.parse(record.ts);
    if (!Number.isFinite(tsMs)) {
      malformedLines += 1;
      return;
    }

    if (tsMs < fromMs || tsMs > toMs) {
      return;
    }

    const rawCorr = extractRawCorrelationId(record, record.msg);
    if (filterCorrelationId !== null && rawCorr !== filterCorrelationId) {
      return;
    }

    matchedEntries += 1;

    const extraKeys = Object.keys(record)
      .filter((k) => k !== "ts" && k !== "level" && k !== "component" && k !== "msg")
      .sort();
    const fields: Record<string, unknown> = {};
    for (const key of extraKeys) {
      const val = record[key];
      if (val === undefined || typeof val === "function") continue;
      fields[key] = sanitizeTimelineField(val, secrets, 0);
    }

    const entry: IncidentTimelineEntry = {
      ts: new Date(tsMs).toISOString(),
      tsMs,
      line: lineNumber,
      level: normalizedLevel,
      component: redactTimelineString(record.component, secrets, 120),
      msg: redactTimelineString(record.msg, secrets, MAX_LOG_FIELD_CHARS),
      correlationId: rawCorr !== null ? redactTimelineString(rawCorr, secrets, 256) : null,
      ...(typeof record.action === "string" && record.action.length > 0
        ? { action: redactTimelineString(record.action, secrets, 120) }
        : {}),
      ...(typeof record.source === "string" && record.source.length > 0
        ? { source: redactTimelineString(record.source, secrets, 80) }
        : {}),
      ...(typeof record.ledger === "number" && Number.isFinite(record.ledger)
        ? { ledger: record.ledger }
        : {}),
      ...(typeof record.eventId === "string" && record.eventId.length > 0
        ? { eventId: redactTimelineString(record.eventId, secrets, 160) }
        : {}),
      ...(typeof record.error === "string" && record.error.length > 0
        ? { error: redactTimelineString(record.error, secrets, MAX_LOG_FIELD_CHARS) }
        : {}),
      fields,
    };

    if (insertBoundedTimelineEntry(kept, entry, maxEntries)) {
      droppedEntries += 1;
    }
  };

  const appendSegment = (segment: string): void => {
    if (discardingCurrentLine || segment.length === 0) return;
    if (partialLine.length + segment.length > maxLineChars) {
      partialLine = "";
      discardingCurrentLine = true;
      oversizedLines += 1;
    } else {
      partialLine += segment;
    }
  };

  const consumeDecodedText = (text: string): void => {
    let start = 0;
    while (start < text.length) {
      const nl = text.indexOf("\n", start);
      if (nl === -1) {
        appendSegment(text.slice(start));
        break;
      }
      appendSegment(text.slice(start, nl));
      scannedLines += 1;
      if (discardingCurrentLine) {
        discardingCurrentLine = false;
        partialLine = "";
      } else {
        const completed = partialLine;
        partialLine = "";
        processCompletedLine(completed, scannedLines);
      }
      start = nl + 1;
    }
  };

  for await (const rawChunk of chunks) {
    const rawBuf =
      typeof rawChunk === "string" ? Buffer.from(rawChunk, "utf8") : Buffer.from(rawChunk);
    if (rawBuf.byteLength === 0) continue;

    if (maxScanBytes !== undefined && scannedBytes + rawBuf.byteLength > maxScanBytes) {
      const allowedBytes = Math.max(0, Math.floor(maxScanBytes - scannedBytes));
      if (allowedBytes > 0) {
        const prefixText = decoder.write(rawBuf.subarray(0, allowedBytes));
        // Only consume up to the last newline within the byte budget so a
        // truncated trailing fragment is never misclassified as malformed JSON.
        const lastNl = prefixText.lastIndexOf("\n");
        if (lastNl !== -1) {
          consumeDecodedText(prefixText.slice(0, lastNl + 1));
        }
      }
      scannedBytes = Math.floor(maxScanBytes);
      scanByteLimitHit = true;
      partialLine = "";
      discardingCurrentLine = false;
      break;
    }

    scannedBytes += rawBuf.byteLength;
    consumeDecodedText(decoder.write(rawBuf));
  }

  if (!scanByteLimitHit) {
    const tail = decoder.end();
    if (tail.length > 0) {
      consumeDecodedText(tail);
    }
    if (discardingCurrentLine) {
      scannedLines += 1;
      discardingCurrentLine = false;
      partialLine = "";
    } else if (partialLine.length > 0) {
      scannedLines += 1;
      const completed = partialLine;
      partialLine = "";
      processCompletedLine(completed, scannedLines);
    }
  }

  kept.sort(compareTimelineEntries);

  return {
    window: {
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
      durationMs,
    },
    correlationId:
      filterCorrelationId !== null ? redactTimelineString(filterCorrelationId, secrets, 256) : null,
    entries: kept,
    stats: {
      scannedLines,
      scannedBytes,
      matchedEntries,
      exportedEntries: kept.length,
      droppedEntries,
      malformedLines,
      oversizedLines,
      truncated: droppedEntries > 0 || scanByteLimitHit,
    },
  };
}

/**
 * Render an {@link IncidentTimelineReport} deterministically as human-readable
 * plain text or single-line/canonical JSON, with no wall-clock dependence.
 */
export function formatIncidentTimeline(
  report: IncidentTimelineReport,
  format: LogFormat = "text",
): string {
  if (format === "json") {
    return JSON.stringify(report);
  }

  const corrLabel = report.correlationId ?? "all";
  const lines: string[] = [
    `Incident timeline · ${report.window.from} .. ${report.window.to} · correlation=${corrLabel}`,
    `entries: ${report.stats.exportedEntries}/${report.stats.matchedEntries} ` +
      `(dropped=${report.stats.droppedEntries}, malformed=${report.stats.malformedLines}, ` +
      `oversized=${report.stats.oversizedLines}, truncated=${report.stats.truncated ? "yes" : "no"})`,
  ];

  if (report.entries.length === 0) {
    lines.push("(no matching log entries)");
    return lines.join("\n");
  }

  for (const entry of report.entries) {
    const meta: string[] = [];
    if (entry.action) meta.push(`action=${entry.action}`);
    if (entry.correlationId) meta.push(`correlation=${entry.correlationId}`);
    if (entry.source) meta.push(`source=${entry.source}`);
    if (entry.ledger !== undefined) meta.push(`ledger=${entry.ledger}`);
    if (entry.eventId) meta.push(`eventId=${entry.eventId}`);
    const metaPart = meta.length > 0 ? ` ${meta.join(" ")}` : "";
    lines.push(`${entry.ts} [${entry.level}] ${entry.component}${metaPart} — ${entry.msg}`);
  }

  return lines.join("\n");
}
