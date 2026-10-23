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

import { networkLabel, type BotConfig } from "./config.js";
import type { PollerStatus } from "./poller.js";

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
