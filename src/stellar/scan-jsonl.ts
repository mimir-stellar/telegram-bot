import type { DecodedEvent } from "./decode.js";
import { eventHistogram, scanJsonReplacer } from "./events.js";

/** Default maximum byte length of a single JSONL record (excluding line ending). */
export const DEFAULT_MAX_JSONL_LINE_BYTES = 64 * 1024; // 64 KiB

/** Default chunk size in bytes when streaming JSONL files from disk. */
export const DEFAULT_JSONL_CHUNK_BYTES = 64 * 1024; // 64 KiB

export interface ScanJsonlEventLine extends DecodedEvent {
  type: "event";
}

export interface ScanJsonlSummaryLine {
  type: "summary";
  eventCount: number;
  histogram: Record<string, number>;
}

export interface BoundedJsonlStreamOptions {
  /**
   * Maximum allowed byte length of a single JSONL record (excluding `\n` / `\r\n`).
   * Records exceeding this limit are rejected before UTF-8 decoding or `JSON.parse`.
   * Defaults to {@link DEFAULT_MAX_JSONL_LINE_BYTES} (64 KiB).
   */
  maxLineBytes?: number;
  /**
   * Optional source label (e.g. filename) included in bounded error diagnostics.
   */
  source?: string;
}

export interface JsonlLineRecord {
  line: string;
  lineNumber: number;
  bytes: number;
}

/**
 * Thrown when a JSONL record exceeds the configured bounded line buffer limit.
 * Never includes raw record bytes in the error message.
 */
export class JsonlLineTooLongError extends Error {
  readonly maxLineBytes: number;
  readonly actualBytes: number;
  readonly lineNumber: number;
  readonly source?: string;

  constructor(opts: {
    maxLineBytes: number;
    actualBytes: number;
    lineNumber: number;
    source?: string;
  }) {
    const where = opts.source ? ` in ${opts.source}` : "";
    super(
      `JSONL record at line ${opts.lineNumber}${where} exceeds max line size of ${opts.maxLineBytes} bytes (observed >= ${opts.actualBytes} bytes)`,
    );
    this.name = "JsonlLineTooLongError";
    this.maxLineBytes = opts.maxLineBytes;
    this.actualBytes = opts.actualBytes;
    this.lineNumber = opts.lineNumber;
    if (opts.source !== undefined) {
      this.source = opts.source;
    }
  }
}

function validatePositiveInt(value: number, name: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive finite integer`);
  }
  return value;
}

function toBuffer(chunk: Buffer | Uint8Array | string): Buffer {
  if (typeof chunk === "string") {
    return Buffer.from(chunk, "utf8");
  }
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }
  return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}

/**
 * Stream non-empty lines from an async iterable of byte chunks (or strings)
 * using a bounded line buffer. Rejects any line whose raw UTF-8 byte length
 * (excluding trailing `\r`/`\n`) exceeds `maxLineBytes` before decoding or parsing.
 */
export async function* streamBoundedJsonlLines(
  chunks: AsyncIterable<Buffer | Uint8Array | string>,
  options: BoundedJsonlStreamOptions = {},
): AsyncGenerator<JsonlLineRecord, void, unknown> {
  const maxLineBytes = validatePositiveInt(
    options.maxLineBytes ?? DEFAULT_MAX_JSONL_LINE_BYTES,
    "maxLineBytes",
  );
  const source = options.source;

  const pendingChunks: Buffer[] = [];
  let pendingBytes = 0;
  let lineNumber = 1;

  for await (const rawChunk of chunks) {
    const chunk = toBuffer(rawChunk);
    if (chunk.byteLength === 0) continue;

    let offset = 0;
    while (offset < chunk.byteLength) {
      const newlineIdx = chunk.indexOf(0x0a, offset);

      if (newlineIdx === -1) {
        // No newline in the remainder of this chunk.
        const rem = chunk.subarray(offset);
        const newPendingBytes = pendingBytes + rem.byteLength;
        // Allow 1 extra byte only if the last byte is `\r` (0x0d), in case
        // the next chunk starts with `\n` (0x0a) to form `\r\n`.
        const endsWithCr = rem[rem.byteLength - 1] === 0x0d;
        const effectiveBytes = endsWithCr ? newPendingBytes - 1 : newPendingBytes;
        if (effectiveBytes > maxLineBytes) {
          throw new JsonlLineTooLongError({
            maxLineBytes,
            actualBytes: effectiveBytes,
            lineNumber,
            ...(source !== undefined ? { source } : {}),
          });
        }
        // Copy so callers may safely reuse the underlying read buffer.
        pendingChunks.push(Buffer.from(rem));
        pendingBytes = newPendingBytes;
        break;
      }

      // Found `\n` at newlineIdx.
      let lineStr: string;
      let lineBytes: number;

      if (pendingBytes === 0) {
        // Fast path: entire line is within the current chunk.
        let lineEnd = newlineIdx;
        if (lineEnd > offset && chunk[lineEnd - 1] === 0x0d) {
          lineEnd -= 1;
        }
        lineBytes = lineEnd - offset;
        if (lineBytes > maxLineBytes) {
          throw new JsonlLineTooLongError({
            maxLineBytes,
            actualBytes: lineBytes,
            lineNumber,
            ...(source !== undefined ? { source } : {}),
          });
        }
        lineStr = chunk.toString("utf8", offset, lineEnd);
      } else {
        // Cross-chunk path: combine pendingChunks + head of current chunk.
        let partEnd = newlineIdx;
        let trimPendingCr = false;

        if (partEnd > offset) {
          if (chunk[partEnd - 1] === 0x0d) {
            partEnd -= 1;
          }
        } else {
          // newlineIdx === offset: check if the previous chunk ended with `\r`.
          const lastPending = pendingChunks[pendingChunks.length - 1];
          if (lastPending && lastPending[lastPending.byteLength - 1] === 0x0d) {
            trimPendingCr = true;
          }
        }

        const partLen = partEnd - offset;
        const effectivePendingBytes = trimPendingCr ? pendingBytes - 1 : pendingBytes;
        lineBytes = effectivePendingBytes + partLen;

        if (lineBytes > maxLineBytes) {
          throw new JsonlLineTooLongError({
            maxLineBytes,
            actualBytes: lineBytes,
            lineNumber,
            ...(source !== undefined ? { source } : {}),
          });
        }

        if (trimPendingCr) {
          const lastIdx = pendingChunks.length - 1;
          const lastBuf = pendingChunks[lastIdx]!;
          if (lastBuf.byteLength === 1) {
            pendingChunks.pop();
          } else {
            pendingChunks[lastIdx] = lastBuf.subarray(0, lastBuf.byteLength - 1);
          }
        }
        if (partLen > 0) {
          pendingChunks.push(chunk.subarray(offset, partEnd));
        }

        const combined =
          pendingChunks.length === 1
            ? pendingChunks[0]!
            : Buffer.concat(pendingChunks, lineBytes);
        lineStr = combined.toString("utf8");
        pendingChunks.length = 0;
        pendingBytes = 0;
      }

      const currentLineNumber = lineNumber;
      lineNumber += 1;
      offset = newlineIdx + 1;

      const trimmed = lineStr.trim();
      if (trimmed.length > 0) {
        yield { line: trimmed, lineNumber: currentLineNumber, bytes: lineBytes };
      }
    }
  }

  // Handle trailing line at EOF without a final `\n`.
  if (pendingBytes > 0) {
    let lineBytes = pendingBytes;
    const lastPending = pendingChunks[pendingChunks.length - 1];
    if (lastPending && lastPending[lastPending.byteLength - 1] === 0x0d) {
      lineBytes -= 1;
      const lastIdx = pendingChunks.length - 1;
      if (lastPending.byteLength === 1) {
        pendingChunks.pop();
      } else {
        pendingChunks[lastIdx] = lastPending.subarray(0, lastPending.byteLength - 1);
      }
    }

    if (lineBytes > maxLineBytes) {
      throw new JsonlLineTooLongError({
        maxLineBytes,
        actualBytes: lineBytes,
        lineNumber,
        ...(source !== undefined ? { source } : {}),
      });
    }

    const combined =
      pendingChunks.length === 1
        ? pendingChunks[0]!
        : Buffer.concat(pendingChunks, lineBytes);
    const trimmed = combined.toString("utf8").trim();
    pendingChunks.length = 0;
    pendingBytes = 0;

    if (trimmed.length > 0) {
      yield { line: trimmed, lineNumber, bytes: lineBytes };
    }
  }
}

/**
 * Stream and parse JSONL records from an async iterable of chunks with a
 * bounded line buffer. Oversized records are rejected before `JSON.parse`.
 */
export async function* parseJsonlStream<T = unknown>(
  chunks: AsyncIterable<Buffer | Uint8Array | string>,
  options: BoundedJsonlStreamOptions = {},
): AsyncGenerator<T, void, unknown> {
  for await (const { line } of streamBoundedJsonlLines(chunks, options)) {
    yield JSON.parse(line) as T;
  }
}

/**
 * Format decoded events as canonical LF (`\n`)-delimited JSON Lines (NDJSON):
 * one event line per decoded event followed by a final `{ type: "summary" }`
 * line containing the histogram from {@link eventHistogram}, with a trailing
 * `\n` regardless of host operating system.
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
