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

/** Hard cap on the rendered export character length, independent of the ring size. */
export const MAX_EXPORT_CHARS = 32_000;

/** Maximum UTF-16 length accepted by Telegram's inline `sendMessage` API. */
export const TELEGRAM_MESSAGE_MAX_CHARS = 4_096;

/** Maximum UTF-16 length accepted by Telegram's `sendDocument` caption field. */
export const TELEGRAM_CAPTION_MAX_CHARS = 1_024;

/** Hard ceiling imposed by Telegram's Bot API `sendDocument` upload limit (50 MiB). */
export const TELEGRAM_DOCUMENT_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Default UTF-8 byte budget for rendered operator log exports (64 KiB).
 * Accommodates multi-byte placeholders (`●●●`, `·`) in 32,000-character exports
 * while keeping attachments compact and strictly within `TELEGRAM_DOCUMENT_MAX_BYTES`.
 */
export const MAX_EXPORT_BYTES = 64 * 1024;

/** Inclusive epoch-millisecond span `[startAt, endAt]` for a set of log lines. */
export interface LogTimeBounds {
  /** Oldest timestamp (`Date.now()` ms) in the span. */
  startAt: number;
  /** Newest timestamp (`Date.now()` ms) in the span. */
  endAt: number;
}

/** Retention and eviction accounting for a bounded `LogCapture` ring buffer. */
export interface LogCaptureStats {
  /** Total lines accepted by `add()` while capture capacity > 0. */
  totalCaptured: number;
  /** Lines currently retained in the ring buffer (`<= capacity`). */
  retainedCount: number;
  /** Lines evicted from the ring buffer due to capacity overflow. */
  omittedCount: number;
  /** Time bounds of lines currently held in the ring (`null` when empty). */
  retainedBounds: LogTimeBounds | null;
  /** Time bounds of lines evicted from the ring (`null` when none evicted). */
  omittedBounds: LogTimeBounds | null;
}

export interface LogCaptureOptions {
  /** Clock override for deterministic tests; defaults to `Date.now`. */
  now?: () => number;
}

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
  /** Optional capture retention/eviction statistics and time bounds. */
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
export function createLogCapture(capacity: number, options?: LogCaptureOptions): LogCapture {
  const cap = Math.max(0, Math.floor(capacity));
  const clock = options?.now ?? (() => Date.now());
  const ring: LogLine[] = [];
  let nextSeq = 0;
  let totalCaptured = 0;
  let omittedCount = 0;
  let omittedBounds: LogTimeBounds | null = null;

  return {
    add(level, text) {
      if (cap === 0) return;
      const line: LogLine = { seq: nextSeq++, at: clock(), level, text };
      totalCaptured += 1;
      if (ring.length >= cap) {
        const evicted = ring.shift();
        if (evicted !== undefined) {
          omittedCount += 1;
          omittedBounds =
            omittedBounds === null
              ? { startAt: evicted.at, endAt: evicted.at }
              : {
                  startAt: Math.min(omittedBounds.startAt, evicted.at),
                  endAt: Math.max(omittedBounds.endAt, evicted.at),
                };
        }
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
        totalCaptured,
        retainedCount: ring.length,
        omittedCount,
        retainedBounds: mergeBoundsFromLines(ring),
        omittedBounds: omittedBounds === null ? null : { ...omittedBounds },
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

function mergeBounds(a: LogTimeBounds | null, b: LogTimeBounds | null): LogTimeBounds | null {
  if (a === null) return b === null ? null : { ...b };
  if (b === null) return { ...a };
  return {
    startAt: Math.min(a.startAt, b.startAt),
    endAt: Math.max(a.endAt, b.endAt),
  };
}

function mergeBoundsFromLines(lines: readonly LogLine[]): LogTimeBounds | null {
  let bounds: LogTimeBounds | null = null;
  for (const line of lines) {
    if (!Number.isFinite(line.at)) continue;
    bounds =
      bounds === null
        ? { startAt: line.at, endAt: line.at }
        : {
            startAt: Math.min(bounds.startAt, line.at),
            endAt: Math.max(bounds.endAt, line.at),
          };
  }
  return bounds;
}

function formatTimestampIso(ms: number): string {
  if (!Number.isFinite(ms)) return "unknown";
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? "unknown" : date.toISOString();
}

function formatBoundsLabel(bounds: LogTimeBounds | null, now: number): string {
  if (bounds === null) return "none";
  return (
    `${formatTimestampIso(bounds.startAt)}..${formatTimestampIso(bounds.endAt)} ` +
    `(${agoShort(bounds.startAt, now)}..${agoShort(bounds.endAt, now)} ago)`
  );
}

export interface LogExportOptions {
  /** Reference epoch timestamp (ms) for relative ages; defaults to `Date.now()`. */
  now?: number;
  /** Maximum rendered character count; defaults to `MAX_EXPORT_CHARS`. */
  maxChars?: number;
  /**
   * Maximum rendered UTF-8 byte count; defaults to `MAX_EXPORT_BYTES` and is
   * hard-clamped to `TELEGRAM_DOCUMENT_MAX_BYTES`.
   */
  maxBytes?: number;
}

export interface LogExportMetadata {
  truncated: boolean;
  ringTruncated: boolean;
  sizeTruncated: boolean;
  totalCaptured: number;
  retainedCount: number;
  omittedCount: number;
  ringOmittedCount: number;
  exportOmittedCount: number;
  omittedBytes: number;
  byteLength: number;
  charLength: number;
  maxChars: number;
  maxBytes: number;
  retainedBounds: LogTimeBounds | null;
  omittedBounds: LogTimeBounds | null;
}

export interface RenderedLogExport {
  text: string;
  meta: LogExportMetadata;
}

interface TruncationNoticeInput {
  totalCaptured: number;
  retainedCount: number;
  omittedCount: number;
  ringOmittedCount: number;
  exportOmittedCount: number;
  omittedBytes: number;
  retainedBounds: LogTimeBounds | null;
  omittedBounds: LogTimeBounds | null;
}

/** Format a compact, plain-text truncation diagnostic line for operator exports. */
export function formatTruncationNotice(
  input: TruncationNoticeInput,
  now: number = Date.now(),
): string {
  const middleDetail =
    input.omittedBytes > 0 ? `, middle-trimmed: ${input.omittedBytes}B` : "";
  return (
    `[truncation: retained ${input.retainedCount} of ${input.totalCaptured} lines, ` +
    `omitted ${input.omittedCount} (ring: ${input.ringOmittedCount}, export: ${input.exportOmittedCount}${middleDetail}) · ` +
    `retained bounds ${formatBoundsLabel(input.retainedBounds, now)} · ` +
    `omitted bounds ${formatBoundsLabel(input.omittedBounds, now)}]`
  );
}

/** Build a bounded plain-text caption (`<= TELEGRAM_CAPTION_MAX_CHARS`) for document exports. */
export function formatLogExportCaption(
  config: BotConfig,
  meta: LogExportMetadata,
  now: number = Date.now(),
): string {
  const prefix = `Mimir notifier log export · v${config.version ?? "unknown"}`;
  const raw = meta.truncated
    ? `${prefix} · ${formatTruncationNotice(meta, now)}`
    : `${prefix} (${meta.retainedCount} lines, ${meta.byteLength}B, no truncation)`;
  if (raw.length <= TELEGRAM_CAPTION_MAX_CHARS) return raw;
  const end = adjustSurrogatePrefixEnd(raw, TELEGRAM_CAPTION_MAX_CHARS - 1);
  return `${raw.slice(0, end)}…`;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function adjustSurrogatePrefixEnd(text: string, end: number): number {
  const clamped = Math.max(0, Math.min(text.length, end));
  if (clamped > 0 && clamped < text.length) {
    if (isHighSurrogate(text.charCodeAt(clamped - 1)) && isLowSurrogate(text.charCodeAt(clamped))) {
      return clamped - 1;
    }
  }
  return clamped;
}

function adjustSurrogateSuffixStart(text: string, start: number): number {
  const clamped = Math.max(0, Math.min(text.length, start));
  if (clamped > 0 && clamped < text.length) {
    if (isHighSurrogate(text.charCodeAt(clamped - 1)) && isLowSurrogate(text.charCodeAt(clamped))) {
      return clamped + 1;
    }
  }
  return clamped;
}

function findPrefixEndWithinLimits(text: string, maxChars: number, maxBytes: number): number {
  if (maxChars <= 0 || maxBytes <= 0 || text.length === 0) return 0;
  let hi = adjustSurrogatePrefixEnd(text, Math.min(text.length, maxChars));
  if (Buffer.byteLength(text.slice(0, hi), "utf8") <= maxBytes) return hi;

  let lo = 0;
  while (lo < hi) {
    const midRaw = Math.ceil((lo + hi) / 2);
    const mid = adjustSurrogatePrefixEnd(text, midRaw);
    if (mid <= lo) {
      // Single code point from `lo` onward: check whether advancing one code point fits.
      const step = isHighSurrogate(text.charCodeAt(lo)) && lo + 1 < text.length ? 2 : 1;
      if (lo + step <= hi && Buffer.byteLength(text.slice(0, lo + step), "utf8") <= maxBytes) {
        lo += step;
      }
      break;
    }
    if (Buffer.byteLength(text.slice(0, mid), "utf8") <= maxBytes) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return adjustSurrogatePrefixEnd(text, lo);
}

function findSuffixStartWithinLimits(
  text: string,
  minStart: number,
  maxChars: number,
  maxBytes: number,
): number {
  if (maxChars <= 0 || maxBytes <= 0 || minStart >= text.length) return text.length;
  let lo = adjustSurrogateSuffixStart(text, Math.max(minStart, text.length - maxChars));
  if (Buffer.byteLength(text.slice(lo), "utf8") <= maxBytes) return lo;

  let hi = text.length;
  while (lo < hi) {
    const midRaw = Math.floor((lo + hi) / 2);
    const mid = adjustSurrogateSuffixStart(text, midRaw);
    if (mid >= hi) {
      const back = isLowSurrogate(text.charCodeAt(hi - 1)) && hi - 2 >= lo ? 2 : 1;
      if (hi - back >= lo && Buffer.byteLength(text.slice(hi - back), "utf8") <= maxBytes) {
        hi -= back;
      }
      break;
    }
    if (Buffer.byteLength(text.slice(mid), "utf8") <= maxBytes) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  return adjustSurrogateSuffixStart(text, hi);
}

function fitsExportLimits(text: string, maxChars: number, maxBytes: number): boolean {
  return text.length <= maxChars && Buffer.byteLength(text, "utf8") <= maxBytes;
}

const OMISSION_MARKER = "…[older log lines omitted]…";

/**
 * Render the operator export together with structured truncation accounting and
 * UTF-8 byte / character size metadata.
 */
export function renderLogExportWithMeta(
  config: BotConfig,
  status: PollerStatus,
  capture: LogCapture,
  options: LogExportOptions = {},
): RenderedLogExport {
  const now = options.now ?? Date.now();
  const effectiveMaxChars = Math.max(256, Math.floor(options.maxChars ?? MAX_EXPORT_CHARS));
  const effectiveMaxBytes = Math.min(
    TELEGRAM_DOCUMENT_MAX_BYTES,
    Math.max(512, Math.floor(options.maxBytes ?? MAX_EXPORT_BYTES)),
  );

  const secrets = secretsFor(config);
  const logs = capture.lines();
  const ringStats = capture.stats?.();
  const ringOmittedCount = ringStats
    ? Math.max(0, ringStats.omittedCount)
    : logs.length > 0
      ? Math.max(0, logs[0]!.seq)
      : 0;
  const totalCaptured = ringStats
    ? Math.max(logs.length + ringOmittedCount, ringStats.totalCaptured)
    : logs.length + ringOmittedCount;
  const ringOmittedBounds = ringStats?.omittedBounds ?? null;
  const ringTruncated = ringOmittedCount > 0;

  const headerLines: string[] = [];
  // The version is public build metadata (also on /health), not a secret.
  headerLines.push(`Mimir notifier log export · v${config.version ?? "unknown"}`);
  // Network label is display-safe (testnet/public/custom) — not the RPC URL,
  // which could name a private endpoint.
  headerLines.push(`network: ${networkLabel(config)} · log lines kept: ${capture.capacity()}`);
  headerLines.push(
    `running: ${status.running ? "yes" : "no"} · cycles: ${status.cycles} · ` +
      `sent: ${status.notificationsSent} · failed sends: ${status.notificationsFailed} · ` +
      `skipped: ${status.eventsSkipped} · consecutive failures: ${status.consecutiveFailures}`,
  );
  headerLines.push(
    `last poll: ${status.lastPollAt ? agoShort(status.lastPollAt, now) : "never"} · ` +
      `last success: ${status.lastSuccessAt ? agoShort(status.lastSuccessAt, now) : "never"}`,
  );
  if (status.lastError) {
    headerLines.push(`last error (${agoShort(status.lastError.at, now)} ago): ${status.lastError.message}`);
  }
  headerLines.push("");
  headerLines.push(`recent logs (${capture.size()} lines, redacted):`);

  const redactedHeader = redactLine(headerLines.join("\n"), secrets);
  const spans: Array<{ line: LogLine; start: number; end: number }> = [];
  let baseText: string;

  if (logs.length === 0) {
    baseText = redactLine(`${redactedHeader}\n(no log lines captured)`, secrets);
  } else {
    const parts: string[] = [redactedHeader];
    let cursor = redactedHeader.length + 1;
    for (const line of logs) {
      const rendered = redactLine(`+${agoShort(line.at, now)} [${line.level}] ${line.text}`, secrets);
      const start = cursor;
      const end = start + rendered.length;
      spans.push({ line, start, end });
      parts.push(rendered);
      cursor = end + 1;
    }
    baseText = redactLine(parts.join("\n"), secrets);
  }

  const ringRetainedBounds = mergeBoundsFromLines(logs);

  if (!ringTruncated && fitsExportLimits(baseText, effectiveMaxChars, effectiveMaxBytes)) {
    const byteLength = Buffer.byteLength(baseText, "utf8");
    return {
      text: baseText,
      meta: {
        truncated: false,
        ringTruncated: false,
        sizeTruncated: false,
        totalCaptured,
        retainedCount: logs.length,
        omittedCount: 0,
        ringOmittedCount: 0,
        exportOmittedCount: 0,
        omittedBytes: 0,
        byteLength,
        charLength: baseText.length,
        maxChars: effectiveMaxChars,
        maxBytes: effectiveMaxBytes,
        retainedBounds: ringRetainedBounds,
        omittedBounds: null,
      },
    };
  }

  if (ringTruncated) {
    const ringNotice = formatTruncationNotice(
      {
        totalCaptured,
        retainedCount: logs.length,
        omittedCount: ringOmittedCount,
        ringOmittedCount,
        exportOmittedCount: 0,
        omittedBytes: 0,
        retainedBounds: ringRetainedBounds,
        omittedBounds: ringOmittedBounds,
      },
      now,
    );
    const withFooter = `${baseText}\n${ringNotice}`;
    if (fitsExportLimits(withFooter, effectiveMaxChars, effectiveMaxBytes)) {
      const byteLength = Buffer.byteLength(withFooter, "utf8");
      return {
        text: withFooter,
        meta: {
          truncated: true,
          ringTruncated: true,
          sizeTruncated: false,
          totalCaptured,
          retainedCount: logs.length,
          omittedCount: ringOmittedCount,
          ringOmittedCount,
          exportOmittedCount: 0,
          omittedBytes: 0,
          byteLength,
          charLength: withFooter.length,
          maxChars: effectiveMaxChars,
          maxBytes: effectiveMaxBytes,
          retainedBounds: ringRetainedBounds,
          omittedBounds: ringOmittedBounds,
        },
      };
    }
  }

  // Keep the summary (the head) and the newest logs (the tail of `lines`).
  // Trim from the middle of the rendered text while enforcing both character
  // and UTF-8 byte bounds (never exceeding Telegram document limits).
  const headMaxChars =
    effectiveMaxChars >= 4_500
      ? 2_000
      : Math.max(0, Math.floor((effectiveMaxChars - 340) * 0.45));
  const headMaxBytes =
    effectiveMaxBytes >= 8_000
      ? 6_000
      : Math.max(0, Math.floor((effectiveMaxBytes - 360) * 0.45));

  const headEnd = findPrefixEndWithinLimits(baseText, headMaxChars, headMaxBytes);
  const head = baseText.slice(0, headEnd);
  const headBytes = Buffer.byteLength(head, "utf8");

  const computeSliceAccounting = (tailStart: number): TruncationNoticeInput => {
    const exportRetained: LogLine[] = [];
    const exportOmitted: LogLine[] = [];
    const exportClipped: LogLine[] = [];
    for (const { line, start, end } of spans) {
      const clampedStart = Math.min(start, baseText.length);
      const clampedEnd = Math.min(end, baseText.length);
      if (clampedStart < headEnd || clampedEnd > tailStart) {
        exportRetained.push(line);
        if (clampedEnd > headEnd && clampedStart < tailStart) {
          exportClipped.push(line);
        }
      } else {
        exportOmitted.push(line);
      }
    }
    const exportOmittedCount = exportOmitted.length;
    const omittedBytes = Buffer.byteLength(baseText.slice(headEnd, tailStart), "utf8");
    const middleBounds =
      exportOmitted.length > 0
        ? mergeBoundsFromLines(exportOmitted)
        : mergeBoundsFromLines(exportClipped);
    return {
      totalCaptured,
      retainedCount: exportRetained.length,
      omittedCount: ringOmittedCount + exportOmittedCount,
      ringOmittedCount,
      exportOmittedCount,
      omittedBytes,
      retainedBounds: mergeBoundsFromLines(exportRetained),
      omittedBounds: mergeBounds(ringOmittedBounds, middleBounds),
    };
  };

  let tailStart = findSuffixStartWithinLimits(
    baseText,
    headEnd,
    Math.max(0, effectiveMaxChars - head.length - 300 - 2),
    Math.max(0, effectiveMaxBytes - headBytes - 310 - 2),
  );
  let accounting = computeSliceAccounting(tailStart);
  let middleBlock = `${OMISSION_MARKER}\n${formatTruncationNotice(accounting, now)}`;

  for (let pass = 0; pass < 4; pass += 1) {
    const middleBytes = Buffer.byteLength(middleBlock, "utf8");
    const tailCharBudget = Math.max(0, effectiveMaxChars - head.length - middleBlock.length - 2);
    const tailByteBudget = Math.max(0, effectiveMaxBytes - headBytes - middleBytes - 2);
    const nextTailStart = findSuffixStartWithinLimits(
      baseText,
      headEnd,
      tailCharBudget,
      tailByteBudget,
    );
    const nextAccounting = computeSliceAccounting(nextTailStart);
    const nextMiddleBlock = `${OMISSION_MARKER}\n${formatTruncationNotice(nextAccounting, now)}`;
    const candidate = `${head}\n${nextMiddleBlock}\n${baseText.slice(nextTailStart)}`;

    tailStart = nextTailStart;
    accounting = nextAccounting;
    middleBlock = nextMiddleBlock;

    if (fitsExportLimits(candidate, effectiveMaxChars, effectiveMaxBytes)) {
      if (pass >= 1) break;
    } else {
      // Tighten by the exact overflow if a power-of-ten digit widened middleBlock.
      const tightCharBudget = Math.max(0, effectiveMaxChars - head.length - middleBlock.length - 2);
      const tightByteBudget = Math.max(
        0,
        effectiveMaxBytes - headBytes - Buffer.byteLength(middleBlock, "utf8") - 2,
      );
      tailStart = findSuffixStartWithinLimits(
        baseText,
        Math.max(headEnd, tailStart),
        tightCharBudget,
        tightByteBudget,
      );
      accounting = computeSliceAccounting(tailStart);
      middleBlock = `${OMISSION_MARKER}\n${formatTruncationNotice(accounting, now)}`;
    }
  }

  let text = `${head}\n${middleBlock}\n${baseText.slice(tailStart)}`;
  if (!fitsExportLimits(text, effectiveMaxChars, effectiveMaxBytes)) {
    const hardEnd = findPrefixEndWithinLimits(text, effectiveMaxChars, effectiveMaxBytes);
    text = text.slice(0, hardEnd);
  }

  const byteLength = Buffer.byteLength(text, "utf8");
  return {
    text,
    meta: {
      truncated: true,
      ringTruncated,
      sizeTruncated: true,
      totalCaptured: accounting.totalCaptured,
      retainedCount: accounting.retainedCount,
      omittedCount: accounting.omittedCount,
      ringOmittedCount: accounting.ringOmittedCount,
      exportOmittedCount: accounting.exportOmittedCount,
      omittedBytes: accounting.omittedBytes,
      byteLength,
      charLength: text.length,
      maxChars: effectiveMaxChars,
      maxBytes: effectiveMaxBytes,
      retainedBounds: accounting.retainedBounds,
      omittedBounds: accounting.omittedBounds,
    },
  };
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
  return renderLogExportWithMeta(config, status, capture, { now }).text;
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
