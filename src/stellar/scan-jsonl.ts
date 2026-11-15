import type { DecodedEvent } from "./decode.js";
import { eventHistogram, scanJsonReplacer } from "./events.js";

export const DEFAULT_MAX_JSONL_LINE_BYTES = 256 * 1024; // 256 KiB
export const DEFAULT_STREAM_CHUNK_BYTES = 64 * 1024; // 64 KiB

export interface ScanJsonlEventLine extends DecodedEvent {
  type: "event";
}

export interface ScanJsonlSummaryLine {
  type: "summary";
  eventCount: number;
  histogram: Record<string, number>;
}

export class OversizedArchiveRecordError extends Error {
  readonly code = "OVERSIZED_ARCHIVE_RECORD" as const;
  readonly source: string;
  readonly line: number;
  readonly maxLineBytes: number;
  readonly observedBytes: number;

  constructor(params: {
    source: string;
    line: number;
    maxLineBytes: number;
    observedBytes: number;
  }) {
    super(
      `Oversized JSONL record at ${params.source}:${params.line}: record exceeds maxLineBytes (${params.observedBytes} > ${params.maxLineBytes})`,
    );
    this.name = "OversizedArchiveRecordError";
    this.source = params.source;
    this.line = params.line;
    this.maxLineBytes = params.maxLineBytes;
    this.observedBytes = params.observedBytes;
  }
}

export interface BoundedLineStreamOptions {
  /** Maximum UTF-8 byte length permitted for a single JSONL line (default: 256 KiB). */
  maxLineBytes?: number | undefined;
  /** Logical source name included in error diagnostics (default: "<stream>"). */
  sourceName?: string | undefined;
}

function validatePositiveInt(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer >= 1, got ${String(value)}`);
  }
  return value;
}

export function normalizeMaxLineBytes(maxLineBytes?: number): number {
  return validatePositiveInt(maxLineBytes, DEFAULT_MAX_JSONL_LINE_BYTES, "maxLineBytes");
}

export function normalizeChunkBytes(chunkBytes?: number): number {
  return validatePositiveInt(chunkBytes, DEFAULT_STREAM_CHUNK_BYTES, "chunkBytes");
}

function stripTrailingCr(buf: Buffer): Buffer {
  if (buf.length > 0 && buf[buf.length - 1] === 0x0d) {
    return buf.subarray(0, buf.length - 1);
  }
  return buf;
}

function stripLeadingUtf8Bom(buf: Buffer): Buffer {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3);
  }
  return buf;
}

/**
 * Incrementally split an async or sync chunk stream into raw UTF-8 JSONL lines
 * using a strictly bounded line accumulator. Rejects any record whose UTF-8
 * byte length exceeds `maxLineBytes` BEFORE buffering the full record or
 * invoking `JSON.parse`.
 */
export async function* streamBoundedJsonlLines(
  chunks: AsyncIterable<Uint8Array | string> | Iterable<Uint8Array | string>,
  options: BoundedLineStreamOptions = {},
): AsyncGenerator<{ lineNumber: number; text: string; byteLength: number }, void, unknown> {
  const maxLineBytes = normalizeMaxLineBytes(options.maxLineBytes);
  const sourceName = options.sourceName ?? "<stream>";

  const pendingParts: Buffer[] = [];
  let pendingBytes = 0;
  let lineNumber = 1;
  let isFirstChunk = true;

  function appendPending(slice: Buffer): void {
    if (slice.length === 0) return;
    const nextBytes = pendingBytes + slice.length;
    const trailingCarryCr = slice[slice.length - 1] === 0x0d ? 1 : 0;
    if (nextBytes - trailingCarryCr > maxLineBytes) {
      pendingParts.length = 0;
      pendingBytes = 0;
      throw new OversizedArchiveRecordError({
        source: sourceName,
        line: lineNumber,
        maxLineBytes,
        observedBytes: nextBytes - trailingCarryCr,
      });
    }
    // Copy slice so callers that reuse a single read buffer across iterations
    // (`handle.read(reusableBuffer, ...)`) never mutate buffered bytes!
    pendingParts.push(Buffer.from(slice));
    pendingBytes = nextBytes;
  }

  function flushLine(tailSlice: Buffer): { text: string; byteLength: number } {
    const totalCandidate = pendingBytes + tailSlice.length;
    // Check trailing CR before rejecting exact-boundary CRLF lines (`maxLineBytes` + `\r`).
    const endsWithCr =
      tailSlice.length > 0
        ? tailSlice[tailSlice.length - 1] === 0x0d
        : pendingParts.length > 0 &&
          pendingParts[pendingParts.length - 1]![
            pendingParts[pendingParts.length - 1]!.length - 1
          ] === 0x0d;
    const effectiveBytes = endsWithCr ? totalCandidate - 1 : totalCandidate;

    if (effectiveBytes > maxLineBytes) {
      pendingParts.length = 0;
      pendingBytes = 0;
      throw new OversizedArchiveRecordError({
        source: sourceName,
        line: lineNumber,
        maxLineBytes,
        observedBytes: effectiveBytes,
      });
    }

    let full: Buffer;
    if (pendingParts.length === 0) {
      full = stripTrailingCr(tailSlice);
    } else {
      if (tailSlice.length > 0) {
        pendingParts.push(tailSlice);
      }
      full = stripTrailingCr(Buffer.concat(pendingParts, totalCandidate));
      pendingParts.length = 0;
      pendingBytes = 0;
    }

    return {
      text: full.toString("utf8"),
      byteLength: full.length,
    };
  }

  for await (const rawChunk of chunks) {
    let chunk =
      typeof rawChunk === "string"
        ? Buffer.from(rawChunk, "utf8")
        : Buffer.isBuffer(rawChunk)
          ? rawChunk
          : Buffer.from(rawChunk.buffer, rawChunk.byteOffset, rawChunk.byteLength);

    if (isFirstChunk && chunk.length > 0) {
      chunk = stripLeadingUtf8Bom(chunk);
      isFirstChunk = false;
    }

    let offset = 0;
    while (offset < chunk.length) {
      const nlIdx = chunk.indexOf(0x0a, offset);
      if (nlIdx === -1) {
        appendPending(chunk.subarray(offset));
        break;
      }

      const currentLine = lineNumber;
      lineNumber += 1;
      const flushed = flushLine(chunk.subarray(offset, nlIdx));
      offset = nlIdx + 1;

      const trimmed = flushed.text.trim();
      if (trimmed.length > 0) {
        yield {
          lineNumber: currentLine,
          text: trimmed,
          byteLength: flushed.byteLength,
        };
      }
    }
  }

  if (pendingBytes > 0) {
    const finalLine = lineNumber;
    const flushed = flushLine(Buffer.alloc(0));
    const trimmed = flushed.text.trim();
    if (trimmed.length > 0) {
      yield {
        lineNumber: finalLine,
        text: trimmed,
        byteLength: flushed.byteLength,
      };
    }
  }
}

/**
 * Stream decoded events from an arbitrary chunked JSONL source with a bounded
 * per-line byte buffer, rejecting oversized records before `JSON.parse`.
 */
export async function* streamScanJsonlEvents(
  chunks: AsyncIterable<Uint8Array | string> | Iterable<Uint8Array | string>,
  options: BoundedLineStreamOptions = {},
): AsyncGenerator<DecodedEvent, void, unknown> {
  const sourceName = options.sourceName ?? "<stream>";
  for await (const { lineNumber, text } of streamBoundedJsonlLines(chunks, options)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(
        `Malformed JSON at ${sourceName}:${lineNumber}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Expected JSON object record at ${sourceName}:${lineNumber}`);
    }
    const obj = parsed as Record<string, unknown>;
    if (obj.type === "summary") continue;
    const { type: _ignoredType, ...rest } = obj;
    yield rest as unknown as DecodedEvent;
  }
}

/**
 * Format decoded events as JSON Lines (NDJSON): one event line per decoded
 * event followed by a final `{ type: "summary" }` line containing the
 * histogram from {@link eventHistogram}.
 */
export function formatScanJsonl(events: readonly DecodedEvent[]): string {
  const lines: string[] = [];
  for (const event of events) {
    lines.push(JSON.stringify({ type: "event", ...event }, scanJsonReplacer));
  }
  const summary: ScanJsonlSummaryLine = {
    type: "summary",
    eventCount: events.length,
    histogram: eventHistogram([...events]),
  };
  lines.push(JSON.stringify(summary, scanJsonReplacer));
  return lines.join("\n") + "\n";
}
