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
 * `LOG_FILE` optionally persists redacted JSONL records to a bounded,
 * size-rotated local sink. Nothing is shipped anywhere.
 */

import {
  appendFile as fsAppendFile,
  mkdir as fsMkdir,
  readdir as fsReaddir,
  rename as fsRename,
  stat as fsStat,
  unlink as fsUnlink,
} from "node:fs/promises";
import path from "node:path";

import { networkLabel, type BotConfig } from "./config.js";
import type { PollerStatus } from "./poller.js";
import { redactError } from "./redact.js";

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

export interface LogCaptureStats {
  /** Number of lines currently retained in the ring buffer. */
  retained: number;
  /** Number of older lines evicted from the ring buffer due to capacity. */
  omitted: number;
  /** Configured ring buffer capacity (0 = capture disabled). */
  capacity: number;
  /** Timestamp (`ms` since epoch) of the oldest retained line, or `null` if empty. */
  oldestAt: number | null;
  /** Timestamp (`ms` since epoch) of the newest retained line, or `null` if empty. */
  newestAt: number | null;
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
  /** Capture retention/truncation counts and time bounds. */
  stats?(): LogCaptureStats;
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
  out = redactInlineUrls(out, {
    secrets,
    placeholder: REDACTED,
    includeRegisteredSecrets: false,
  });
  out = out
    .replace(/\b(?:bot)?\d{5,}:[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g, REDACTED)
    .replace(/\bS[A-Z2-7]{55}\b/g, REDACTED);
  // Full-precision Stellar strkeys (G…/C…, 56 chars) -> first 4 + … + last 4.
  // Shortened display forms like `CDV6…LPKZI` are left alone; the ellipsis
  // means there is nothing more to hide.
  out = out.replace(/\b[GC][A-Z2-7]{55}\b/g, (m) => `${m.slice(0, 4)}…${m.slice(-4)}`);
  return stripTerminalEscapes(out);
}

/** Derive the literal substrings that must never survive into the buffer. */
export function secretsFor(config: BotConfig): string[] {
  return [config.botToken, config.chatId].filter((s) => s.length > 0);
}

/**
 * Create the ring buffer. Capacity 0 means capture is disabled: `add` is a
 * no-op and `lines()` is always empty, so callers need no special casing.
 */
export function createLogCapture(capacity: number, now: () => number = Date.now): LogCapture {
  const cap = Math.max(0, Math.floor(capacity));
  const ring: LogLine[] = [];
  let nextSeq = 0;
  let omitted = 0;

  return {
    add(level, text) {
      if (cap === 0) return;
      const line: LogLine = { seq: nextSeq++, at: now(), level, text };
      if (ring.length >= cap) {
        ring.shift();
        omitted += 1;
      }
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
    stats() {
      return {
        retained: ring.length,
        omitted,
        capacity: cap,
        oldestAt: ring[0]?.at ?? null,
        newestAt: ring[ring.length - 1]?.at ?? null,
      };
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
  const logs = capture.lines();
  const stats: LogCaptureStats = capture.stats?.() ?? {
    retained: logs.length,
    omitted: 0,
    capacity: capture.capacity(),
    oldestAt: logs[0]?.at ?? null,
    newestAt: logs[logs.length - 1]?.at ?? null,
  };
  const timeBounds =
    stats.oldestAt !== null && stats.newestAt !== null
      ? `${new Date(stats.oldestAt).toISOString()}..${new Date(stats.newestAt).toISOString()}`
      : "none";
  lines.push(
    `log capture: retained ${stats.retained} · omitted ${stats.omitted} · ` +
      `truncated: ${stats.omitted > 0 ? "yes" : "no"} · window: ${timeBounds}`,
  );
  lines.push("");
  lines.push(`recent logs (${capture.size()} lines, redacted):`);

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
export const LOG_FILE_ENV = "LOG_FILE";
export const LOG_FILE_MAX_BYTES_ENV = "LOG_FILE_MAX_BYTES";
export const LOG_FILE_MAX_FILES_ENV = "LOG_FILE_MAX_FILES";
export const LOGGER_CONFIG_KEYS: readonly { key: string; secret: boolean }[] = Object.freeze([
  { key: LOG_LEVEL_ENV, secret: false },
  { key: LOG_FORMAT_ENV, secret: false },
  { key: LOG_FILE_ENV, secret: false },
  { key: LOG_FILE_MAX_BYTES_ENV, secret: false },
  { key: LOG_FILE_MAX_FILES_ENV, secret: false },
]);
export const DEFAULT_LOG_LEVEL: LogLevel = "info";
export const DEFAULT_LOG_FORMAT: LogFormat = "text";
export const DEFAULT_LOG_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_LOG_FILE_MAX_FILES = 5;
export const MAX_LOG_FILE_COUNT = 50;
/** Every accepted LOG_LEVEL value, lowest severity first. */
export const LOG_LEVELS: readonly LogLevel[] = Object.freeze(["debug", "info", "warn", "error", "fatal"]);
/** Every accepted LOG_FORMAT value. */
export const LOG_FORMATS: readonly LogFormat[] = Object.freeze(["text", "json"]);
/** Longest string any single field may carry into a JSON record. */
export const MAX_LOG_FIELD_CHARS = 1_000;

export type JsonlDiskFailureStage = "mkdir" | "stat" | "rotate" | "write" | "cleanup";
export type JsonlDiskFailureReason =
  | "disk_full"
  | "permission_denied"
  | "read_only_fs"
  | "busy"
  | "path_error"
  | "io_error";

export interface JsonlDiskFailure {
  stage: JsonlDiskFailureStage;
  reason: JsonlDiskFailureReason;
  code: string | null;
  targetPath: string;
  message: string;
  at: string;
}

export interface JsonlWriterStats {
  filePath: string;
  maxBytes: number;
  maxFiles: number;
  currentBytes: number;
  writesSucceeded: number;
  writesDropped: number;
  rotations: number;
  failuresByStage: Record<JsonlDiskFailureStage, number>;
  failuresByReason: Record<JsonlDiskFailureReason, number>;
  lastFailure: JsonlDiskFailure | null;
}

export interface JsonlFsOps {
  mkdir(dirPath: string, options?: { recursive?: boolean }): Promise<unknown>;
  stat(filePath: string): Promise<{ size: number }>;
  readdir(dirPath: string): Promise<string[]>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
  appendFile(filePath: string, data: string | Uint8Array): Promise<void>;
}

export interface RotatingJsonlWriterOptions {
  filePath: string;
  maxBytes?: number;
  maxFiles?: number;
  secrets?: readonly string[];
  now?: () => Date;
  onFailure?: (failure: JsonlDiskFailure) => void;
  fsOps?: Partial<JsonlFsOps>;
}

export interface RotatingJsonlWriter {
  write(line: string): Promise<boolean>;
  flush(): Promise<void>;
  stats(): JsonlWriterStats;
  setSecrets(secrets: readonly string[]): void;
}

const LOG_REDACTED = "[REDACTED]";
const MAX_FIELD_DEPTH = 4;
const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 };
const TELEGRAM_TOKEN_SHAPE = /\b(?:bot)?\d{5,}:[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g;
const STELLAR_SECRET_SEED_SHAPE = /\bS[A-Z2-7]{55}\b/g;

export function parseLogLevel(value: unknown): LogLevel {
  if (typeof value !== "string") return DEFAULT_LOG_LEVEL;
  const normalized = value.trim().toLowerCase();
  return normalized in LEVEL_RANK ? (normalized as LogLevel) : DEFAULT_LOG_LEVEL;
}

export function parseLogFormat(value: unknown): LogFormat {
  if (typeof value !== "string") return DEFAULT_LOG_FORMAT;
  return value.trim().toLowerCase() === "json" ? "json" : DEFAULT_LOG_FORMAT;
}

export function parseLogFilePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parsePositiveInt(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 1 ? value : null;
  }
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return null;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

export function parseLogFileMaxBytes(value: unknown): number {
  return parsePositiveInt(value) ?? DEFAULT_LOG_FILE_MAX_BYTES;
}

export function parseLogFileMaxFiles(value: unknown): number {
  const parsed = parsePositiveInt(value);
  if (parsed === null) return DEFAULT_LOG_FILE_MAX_FILES;
  return Math.min(parsed, MAX_LOG_FILE_COUNT);
}

function errorCode(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function isMissingFileError(err: unknown): boolean {
  return errorCode(err) === "ENOENT";
}

export function classifyJsonlDiskError(err: unknown): {
  reason: JsonlDiskFailureReason;
  code: string | null;
} {
  const code = errorCode(err);
  switch (code) {
    case "ENOSPC":
    case "EDQUOT":
      return { reason: "disk_full", code };
    case "EACCES":
    case "EPERM":
      return { reason: "permission_denied", code };
    case "EROFS":
      return { reason: "read_only_fs", code };
    case "EBUSY":
    case "ETXTBSY":
      return { reason: "busy", code };
    case "ENOENT":
    case "ENOTDIR":
    case "EISDIR":
    case "ENAMETOOLONG":
    case "ELOOP":
    case "EXDEV":
      return { reason: "path_error", code };
    default:
      return { reason: "io_error", code };
  }
}

export function createRotatingJsonlWriter(options: RotatingJsonlWriterOptions): RotatingJsonlWriter {
  const configuredPath = options.filePath.trim();
  if (!configuredPath) {
    throw new Error("RotatingJsonlWriter requires a non-empty filePath");
  }
  const resolvedPath = path.resolve(configuredPath);
  const dir = path.dirname(resolvedPath);
  const base = path.basename(resolvedPath);
  const maxBytes = parseLogFileMaxBytes(options.maxBytes);
  const maxFiles = parseLogFileMaxFiles(options.maxFiles);
  let secrets = [...(options.secrets ?? [])];
  const now = options.now ?? (() => new Date());
  const fs: JsonlFsOps = {
    mkdir: fsMkdir,
    stat: fsStat,
    readdir: fsReaddir,
    rename: fsRename,
    unlink: fsUnlink,
    appendFile: fsAppendFile,
    ...options.fsOps,
  };

  let initialized = false;
  let currentBytes = 0;
  let writesSucceeded = 0;
  let writesDropped = 0;
  let rotations = 0;
  const failuresByStage: Record<JsonlDiskFailureStage, number> = {
    mkdir: 0,
    stat: 0,
    rotate: 0,
    write: 0,
    cleanup: 0,
  };
  const failuresByReason: Record<JsonlDiskFailureReason, number> = {
    disk_full: 0,
    permission_denied: 0,
    read_only_fs: 0,
    busy: 0,
    path_error: 0,
    io_error: 0,
  };
  let lastFailure: JsonlDiskFailure | null = null;
  let queue: Promise<void> = Promise.resolve();

  function reportFailure(stage: JsonlDiskFailureStage, target: string, err: unknown): JsonlDiskFailure {
    const { reason, code } = classifyJsonlDiskError(err);
    let at: string;
    try {
      at = now().toISOString();
    } catch {
      at = new Date(0).toISOString();
    }
    const failure: JsonlDiskFailure = {
      stage,
      reason,
      code,
      targetPath: redactError(target, { secrets }),
      message: redactError(err, { secrets }),
      at,
    };
    failuresByStage[stage] += 1;
    failuresByReason[reason] += 1;
    lastFailure = failure;
    if (options.onFailure) {
      try {
        options.onFailure(failure);
      } catch {
        return failure;
      }
    }
    return failure;
  }

  async function pruneExcessArchives(): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch (err) {
      if (!isMissingFileError(err)) reportFailure("cleanup", dir, err);
      return;
    }
    const prefix = `${base}.`;
    const stale: number[] = [];
    for (const entry of entries) {
      if (!entry.startsWith(prefix)) continue;
      const suffix = entry.slice(prefix.length);
      if (!/^[1-9]\d*$/.test(suffix)) continue;
      const index = Number.parseInt(suffix, 10);
      if (Number.isSafeInteger(index) && index >= maxFiles) stale.push(index);
    }
    stale.sort((a, b) => a - b);
    for (const index of stale) {
      const stalePath = path.join(dir, `${base}.${index}`);
      try {
        await fs.unlink(stalePath);
      } catch (err) {
        if (!isMissingFileError(err)) reportFailure("cleanup", stalePath, err);
      }
    }
  }

  async function ensureInitialized(): Promise<boolean> {
    if (initialized) return true;
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (err) {
      reportFailure("mkdir", dir, err);
      return false;
    }
    try {
      const info = await fs.stat(resolvedPath);
      currentBytes = Number.isFinite(info.size) ? Math.max(0, Math.floor(info.size)) : 0;
    } catch (err) {
      if (!isMissingFileError(err)) {
        reportFailure("stat", resolvedPath, err);
        return false;
      }
      currentBytes = 0;
    }
    await pruneExcessArchives();
    initialized = true;
    return true;
  }

  async function performRotation(): Promise<boolean> {
    if (maxFiles <= 1) {
      try {
        await fs.unlink(resolvedPath);
      } catch (err) {
        if (!isMissingFileError(err)) {
          reportFailure("rotate", resolvedPath, err);
          return false;
        }
      }
      currentBytes = 0;
      rotations += 1;
      await pruneExcessArchives();
      return true;
    }

    const oldest = `${resolvedPath}.${maxFiles - 1}`;
    try {
      await fs.unlink(oldest);
    } catch (err) {
      if (!isMissingFileError(err)) {
        reportFailure("rotate", oldest, err);
        return false;
      }
    }

    for (let index = maxFiles - 2; index >= 1; index -= 1) {
      const source = `${resolvedPath}.${index}`;
      const destination = `${resolvedPath}.${index + 1}`;
      try {
        await fs.rename(source, destination);
      } catch (err) {
        if (!isMissingFileError(err)) {
          reportFailure("rotate", source, err);
          return false;
        }
      }
    }

    try {
      await fs.rename(resolvedPath, `${resolvedPath}.1`);
    } catch (err) {
      if (!isMissingFileError(err)) {
        reportFailure("rotate", resolvedPath, err);
        return false;
      }
    }
    currentBytes = 0;
    rotations += 1;
    await pruneExcessArchives();
    return true;
  }

  async function writeOne(rawLine: string): Promise<boolean> {
    const line = typeof rawLine === "string" ? rawLine : String(rawLine);
    const payload = `${line.replace(/[\r\n]+$/g, "")}\n`;
    const payloadBytes = Buffer.byteLength(payload, "utf8");
    if (!(await ensureInitialized())) {
      writesDropped += 1;
      return false;
    }
    if (currentBytes > 0 && currentBytes + payloadBytes > maxBytes) {
      await performRotation();
    }
    try {
      await fs.appendFile(resolvedPath, payload);
      currentBytes += payloadBytes;
      writesSucceeded += 1;
      return true;
    } catch (err) {
      reportFailure("write", resolvedPath, err);
      writesDropped += 1;
      return false;
    }
  }

  return {
    write(line: string): Promise<boolean> {
      const pending = queue.then(() => writeOne(line));
      queue = pending.then(
        () => undefined,
        () => undefined,
      );
      return pending;
    },
    flush(): Promise<void> {
      return queue;
    },
    stats(): JsonlWriterStats {
      return {
        filePath: configuredPath,
        maxBytes,
        maxFiles,
        currentBytes,
        writesSucceeded,
        writesDropped,
        rotations,
        failuresByStage: { ...failuresByStage },
        failuresByReason: { ...failuresByReason },
        lastFailure: lastFailure ? { ...lastFailure } : null,
      };
    },
    setSecrets(nextSecrets: readonly string[]): void {
      secrets = [...nextSecrets];
    },
  };
}

const consoleSink: LogSink = (level, line) => {
  if (level === "error" || level === "fatal") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};

const defaultDiskFailureSink = (failure: JsonlDiskFailure): void => {
  const code = failure.code ? ` code=${failure.code}` : "";
  console.error(
    `[logger] jsonl disk failure stage=${failure.stage} reason=${failure.reason}${code}: ${failure.message}`,
  );
};

function safeInvokeSink(sink: LogSink, level: LogLevel, line: string, fallbackLine: string): void {
  try {
    sink(level, line);
  } catch {
    try {
      consoleSink(level, fallbackLine);
    } catch {
      // Never let a sink failure terminate the caller or polling loop.
    }
  }
}

interface LoggerState {
  level: LogLevel;
  format: LogFormat;
  sink: LogSink;
  secrets: string[];
  now: () => Date;
  jsonlWriter: RotatingJsonlWriter | null;
  onDiskFailure: (failure: JsonlDiskFailure) => void;
}

function defaultState(): LoggerState {
  return {
    level: DEFAULT_LOG_LEVEL,
    format: DEFAULT_LOG_FORMAT,
    sink: consoleSink,
    secrets: [],
    now: () => new Date(),
    jsonlWriter: null,
    onDiskFailure: defaultDiskFailureSink,
  };
}

let state = defaultState();

function redactLogText(text: string): string {
  let out = text;
  const secrets = [...state.secrets, ...registeredSecrets()]
    .filter((secret) => secret.length > 0)
    .sort((a, b) => b.length - a.length);
  for (const secret of secrets) {
    if (out.includes(secret)) out = out.split(secret).join(LOG_REDACTED);
  }
  out = redactInlineUrls(out, {
    secrets,
    placeholder: LOG_REDACTED,
    includeRegisteredSecrets: false,
  });
  return stripTerminalEscapes(out.replace(TELEGRAM_TOKEN_SHAPE, LOG_REDACTED));
}

function boundField(text: string): string {
  return text.length <= MAX_LOG_FIELD_CHARS ? text : `${text.slice(0, MAX_LOG_FIELD_CHARS - 1)}…`;
}

function sanitize(value: unknown, depth: number): unknown {
  if (typeof value === "string") return boundField(redactLogText(value));
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol") return "[unsupported:symbol]";
  if (typeof value === "function") return "[unsupported:function]";
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

function serializeJsonRecord(
  level: LogLevel,
  component: string,
  msg: string,
  fields?: LogFields,
): { ok: true; json: string } | { ok: false; fallbackJson: string } {
  let ts: string;
  try {
    ts = state.now().toISOString();
  } catch {
    ts = new Date(0).toISOString();
  }
  try {
    const safe: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(fields ?? {})) {
      if (item === undefined || typeof item === "function") continue;
      safe[key] = sanitize(item, 0);
    }
    return { ok: true, json: JSON.stringify({ ...safe, ts, level, component, msg }) };
  } catch {
    return { ok: false, fallbackJson: JSON.stringify({ ts, level, component, msg }) };
  }
}

function emit(level: LogLevel, component: string, message: string, fields?: LogFields): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[state.level]) return;
  const msg = redactLogText(message);
  const serialized = serializeJsonRecord(level, component, msg, fields);
  if (state.format === "json") {
    safeInvokeSink(state.sink, level, serialized.ok ? serialized.json : msg, msg);
  } else {
    safeInvokeSink(state.sink, level, msg, msg);
  }
  if (state.jsonlWriter) {
    const line = serialized.ok ? serialized.json : serialized.fallbackJson;
    void state.jsonlWriter.write(line).catch(() => undefined);
  }
}

export const Logger = {
  configure(options: Partial<LoggerState>): void {
    state = { ...state, ...options };
    if (options.jsonlWriter !== undefined || options.secrets !== undefined) {
      state.jsonlWriter?.setSecrets(state.secrets);
    }
  },
  configureFromEnv(env: Record<string, string | undefined> = process.env): void {
    const filePath = parseLogFilePath(env[LOG_FILE_ENV]);
    const jsonlWriter =
      filePath === null
        ? null
        : createRotatingJsonlWriter({
            filePath,
            maxBytes: parseLogFileMaxBytes(env[LOG_FILE_MAX_BYTES_ENV]),
            maxFiles: parseLogFileMaxFiles(env[LOG_FILE_MAX_FILES_ENV]),
            secrets: state.secrets,
            now: () => state.now(),
            onFailure: (failure) => state.onDiskFailure(failure),
          });
    state = {
      ...state,
      level: parseLogLevel(env[LOG_LEVEL_ENV]),
      format: parseLogFormat(env[LOG_FORMAT_ENV]),
      jsonlWriter,
    };
  },
  reset(): void {
    state = defaultState();
  },
  flush(): Promise<void> {
    return state.jsonlWriter ? state.jsonlWriter.flush() : Promise.resolve();
  },
  getJsonlStats(): JsonlWriterStats | null {
    return state.jsonlWriter ? state.jsonlWriter.stats() : null;
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
