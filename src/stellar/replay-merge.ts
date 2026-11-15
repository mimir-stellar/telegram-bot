/**
 * Bounded-memory streaming k-way merge for replay and scanner event chunks.
 *
 * Merges multiple ordered scan/replay chunk files (`.jsonl` event streams or
 * `mimir-scan-v1` JSON chunk reports) or programmatic event iterables into a
 * single canonical JSONL stream (`{ type: "event", ... }` lines followed by a
 * `{ type: "summary", ... }` line) while preserving:
 *
 *  1. Canonical chain ordering (`compareEvents`: ledger -> transactionIndex ->
 *     operationIndex -> eventId -> txHash, with deterministic source/contract
 *     tie-breaking).
 *  2. Canonical duplicate policy (`eventKey` + bounded `EventDedupWindow`:
 *     first occurrence wins, unidentifiable events without `eventId` are kept
 *     and never assigned synthetic identities).
 *  3. Strictly bounded O(K + dedupWindow) resident memory across arbitrarily
 *     long histories, honoring Writable `drain` backpressure.
 */

import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";

import { DEFAULT_DEDUP_WINDOW, EventDedupWindow, eventKey } from "../dedup.js";
import { safeErrorMessage } from "../notifications/format.js";
import {
  DEFAULT_CONTRACT_VERSION,
  compareEvents,
  sortEvents,
  type ContractSource,
  type DecodedEvent,
} from "./decode.js";
import { scanJsonReplacer } from "./events.js";
import type { ScanJsonlSummaryLine } from "./scan-jsonl.js";
import { ScanReviverError, reviveScanReport } from "./scan-reviver.js";

/** Maximum bytes allowed for a single JSONL line before aborting (256 KiB). */
export const MAX_CHUNK_LINE_BYTES = 262_144;

/** Maximum file size allowed for non-streaming `mimir-scan-v1` JSON chunks (16 MiB). */
export const MAX_JSON_CHUNK_FILE_BYTES = 16 * 1024 * 1024;

/** Upper bound on distinct histogram keys retained in memory. */
export const MAX_MERGE_HISTOGRAM_KEYS = 256;

export type ReplayChunkMergeErrorCode =
  | "EMPTY_CHUNKS"
  | "CHUNK_READ_ERROR"
  | "OVERSIZED_CHUNK_LINE"
  | "OVERSIZED_JSON_CHUNK"
  | "MALFORMED_CHUNK"
  | "OUT_OF_ORDER_CHUNK";

const MAX_MERGE_ERROR_CHARS = 240;

function boundedMergeMessage(msg: string): string {
  const clean = safeErrorMessage(msg, []).replace(/\s+/g, " ").trim();
  return clean.length <= MAX_MERGE_ERROR_CHARS
    ? clean
    : `${clean.slice(0, MAX_MERGE_ERROR_CHARS - 1)}…`;
}

/** Bounded error raised when a replay scan chunk cannot be safely merged. */
export class ReplayChunkMergeError extends Error {
  readonly code: ReplayChunkMergeErrorCode;

  constructor(code: ReplayChunkMergeErrorCode, message: string) {
    super(boundedMergeMessage(message));
    this.name = "ReplayChunkMergeError";
    this.code = code;
  }
}

export interface ReplayMergedSummaryLine extends ScanJsonlSummaryLine {
  type: "summary";
  eventCount: number;
  duplicates: number;
  chunksMerged: number;
  firstLedger: number | null;
  lastLedger: number | null;
  histogram: Record<string, number>;
}

export type ReplayChunkMergeResult = ReplayMergedSummaryLine;

export interface ReplayChunkMergeOptions {
  /** Destination writable stream for JSONL output. When omitted, lines are counted without writing. */
  output?: NodeJS.WritableStream | undefined;
  /** Per-contract deduplication window capacity (default: 256; 0 disables dedup). */
  dedupWindow?: number | undefined;
  /** Optional single-contract filter (`"market"` or `"squad"`). */
  contract?: ContractSource | undefined;
  /** Optional inclusive lower ledger bound. */
  fromLedger?: number | undefined;
  /** Optional inclusive upper ledger bound. */
  toLedger?: number | undefined;
  /** Maximum bytes permitted per JSONL line (default: 256 KiB). */
  maxLineBytes?: number | undefined;
  /** Override reported chunk count when physical files expand into per-contract sub-streams. */
  chunksMergedCount?: number | undefined;
}

/** Known bigint payload fields matching `scan-reviver.ts`. */
const BIGINT_PAYLOAD_FIELDS: Record<string, readonly string[]> = {
  claim_challenged: ["stake"],
  market_settled: ["totalPaid", "totalFees", "owedToChallengers", "dust"],
  challenger_paid: ["stake", "gross", "fee", "net"],
  fee_claimed: ["amount"],
  withdrawal: ["amount"],
  withdrawal_pending: ["amount"],
  deposited: ["amount", "shares"],
  withdrawn: ["amount"],
  resolved: ["poolA", "poolB"],
  claimed: ["gross", "fee", "net"],
  fees_claimed: ["amount"],
  fee_accrued: ["amount"],
};

function parseBigIntField(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    try {
      return BigInt(value.trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function reviveDecodedPayload(payload: DecodedEvent["payload"]): DecodedEvent["payload"] {
  if (!payload || typeof payload !== "object") return payload;
  const fields = BIGINT_PAYLOAD_FIELDS[payload.name];
  if (!fields) return payload;
  const clone: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
  for (const field of fields) {
    const revived = parseBigIntField(clone[field]);
    if (revived !== undefined) {
      clone[field] = revived;
    }
  }
  return clone as DecodedEvent["payload"];
}

function normalizeOptionalIndex(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  throw new ReplayChunkMergeError(
    "MALFORMED_CHUNK",
    `invalid ${label} in chunk event (expected non-negative integer or null)`,
  );
}

/**
 * Validate and normalize a parsed JSONL object into a `DecodedEvent`, or return
 * `null` when the line is a valid `{ type: "summary" }` trailer.
 */
function parseChunkJsonObject(
  raw: unknown,
  chunkLabel: string,
  lineNumber: number,
): DecodedEvent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ReplayChunkMergeError(
      "MALFORMED_CHUNK",
      `${chunkLabel}:${lineNumber}: expected JSON object`,
    );
  }
  const obj = raw as Record<string, unknown>;
  if (obj.type === "summary") {
    return null;
  }
  if (obj.type !== undefined && obj.type !== "event") {
    throw new ReplayChunkMergeError(
      "MALFORMED_CHUNK",
      `${chunkLabel}:${lineNumber}: unsupported JSONL record type "${String(obj.type)}"`,
    );
  }

  const source = obj.source;
  if (source !== "market" && source !== "squad") {
    throw new ReplayChunkMergeError(
      "MALFORMED_CHUNK",
      `${chunkLabel}:${lineNumber}: invalid or missing source (expected "market" or "squad")`,
    );
  }

  const ledger = obj.ledger;
  if (typeof ledger !== "number" || !Number.isSafeInteger(ledger) || ledger < 0) {
    throw new ReplayChunkMergeError(
      "MALFORMED_CHUNK",
      `${chunkLabel}:${lineNumber}: invalid or missing ledger number`,
    );
  }

  const payload = obj.payload;
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    typeof (payload as { name?: unknown }).name !== "string" ||
    (payload as { name: string }).name.trim() === ""
  ) {
    throw new ReplayChunkMergeError(
      "MALFORMED_CHUNK",
      `${chunkLabel}:${lineNumber}: invalid or missing event payload`,
    );
  }

  const contractId = typeof obj.contractId === "string" ? obj.contractId : "";
  const version =
    typeof obj.version === "string" && obj.version.trim() !== ""
      ? obj.version
      : DEFAULT_CONTRACT_VERSION;
  const txHash = typeof obj.txHash === "string" ? obj.txHash.trim() : "";
  const at =
    typeof obj.at === "number" && Number.isFinite(obj.at) && obj.at >= 0
      ? Math.trunc(obj.at)
      : 0;
  const eventId =
    typeof obj.eventId === "string"
      ? obj.eventId
      : typeof obj.id === "string"
        ? obj.id
        : "";
  const eventType = typeof obj.eventType === "string" ? obj.eventType : "contract";
  const transactionIndex = normalizeOptionalIndex(
    obj.transactionIndex,
    `${chunkLabel}:${lineNumber} transactionIndex`,
  );
  const operationIndex = normalizeOptionalIndex(
    obj.operationIndex,
    `${chunkLabel}:${lineNumber} operationIndex`,
  );
  const inSuccessfulContractCall =
    typeof obj.inSuccessfulContractCall === "boolean"
      ? obj.inSuccessfulContractCall
      : null;

  return {
    source,
    contractId,
    version,
    ledger,
    txHash,
    at,
    eventId,
    eventType,
    transactionIndex,
    operationIndex,
    inSuccessfulContractCall,
    payload: reviveDecodedPayload(payload as DecodedEvent["payload"]),
  };
}

/**
 *Deterministic total-order comparison across multi-contract decoded events.
 * Extends `compareEvents` (ledger -> txIndex -> opIndex -> eventId -> txHash)
 * with contract source, contractId, and payload name so cross-contract merges
 * produce identical ordering regardless of chunk argument order.
 */
export function compareReplayChunkEvents(a: DecodedEvent, b: DecodedEvent): number {
  const base = compareEvents(a, b);
  if (base !== 0) return base;
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  if (a.contractId !== b.contractId) return a.contractId < b.contractId ? -1 : 1;
  if (a.payload.name !== b.payload.name) return a.payload.name < b.payload.name ? -1 : 1;
  return 0;
}

async function writeLineWithBackpressure(
  stream: NodeJS.WritableStream,
  line: string,
): Promise<void> {
  const canContinue = stream.write(line);
  if (!canContinue) {
    await once(stream, "drain");
  }
}

function recordBoundedHistogram(
  counts: Map<string, number>,
  event: DecodedEvent,
): void {
  let key =
    event.payload.name === "unknown"
      ? `unknown:${event.payload.eventName || "?"}`
      : event.payload.name;
  if (!counts.has(key) && counts.size >= MAX_MERGE_HISTOGRAM_KEYS) {
    key = event.payload.name === "unknown" ? "unknown:*" : "other:*";
  }
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function finalizeHistogram(counts: Map<string, number>): Record<string, number> {
  return Object.fromEntries(
    [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
  );
}

interface ActiveStreamHead {
  streamIndex: number;
  seq: number;
  event: DecodedEvent;
}

/**
 * Stream-merge ordered event chunks into canonical JSONL with O(K + dedupWindow)
 * bounded memory. Pulls at most one active head event from each chunk iterator
 * at any time.
 */
export async function mergeReplayScanChunks(
  chunks: ReadonlyArray<AsyncIterable<DecodedEvent> | Iterable<DecodedEvent>>,
  opts: ReplayChunkMergeOptions = {},
): Promise<ReplayChunkMergeResult> {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    throw new ReplayChunkMergeError(
      "EMPTY_CHUNKS",
      "at least one replay scan chunk is required",
    );
  }

  const dedupCapacity =
    opts.dedupWindow === undefined
      ? DEFAULT_DEDUP_WINDOW
      : Number.isFinite(opts.dedupWindow)
        ? Math.max(0, Math.floor(opts.dedupWindow))
        : DEFAULT_DEDUP_WINDOW;
  const dedupEnabled = dedupCapacity > 0;
  const dedupBySource: Record<ContractSource, EventDedupWindow> = {
    market: new EventDedupWindow(dedupCapacity),
    squad: new EventDedupWindow(dedupCapacity),
  };
  const lastKeyBySource: Record<ContractSource, string | null> = {
    market: null,
    squad: null,
  };

  const contractFilter = opts.contract;
  const fromLedger = opts.fromLedger;
  const toLedger = opts.toLedger;
  const output = opts.output;

  const iterators: Array<AsyncIterator<DecodedEvent> | Iterator<DecodedEvent>> = chunks.map(
    (chunk) => {
      const asyncCandidate = chunk as AsyncIterable<DecodedEvent>;
      if (typeof asyncCandidate[Symbol.asyncIterator] === "function") {
        return asyncCandidate[Symbol.asyncIterator]();
      }
      return (chunk as Iterable<DecodedEvent>)[Symbol.iterator]();
    },
  );

  const heads: Array<ActiveStreamHead | null> = new Array(iterators.length).fill(null);
  const lastPerStream: Array<DecodedEvent | null> = new Array(iterators.length).fill(null);
  const seqPerStream: number[] = new Array(iterators.length).fill(0);

  async function pullNext(streamIndex: number): Promise<void> {
    const iter = iterators[streamIndex];
    if (!iter) {
      heads[streamIndex] = null;
      return;
    }
    for (;;) {
      const step = await iter.next();
      if (step.done) {
        heads[streamIndex] = null;
        return;
      }
      const ev = step.value;
      if (!ev || typeof ev !== "object") {
        throw new ReplayChunkMergeError(
          "MALFORMED_CHUNK",
          `chunk[${streamIndex}] yielded a non-object event`,
        );
      }
      const prev = lastPerStream[streamIndex] ?? null;
      if (prev !== null && compareEvents(ev, prev) < 0) {
        throw new ReplayChunkMergeError(
          "OUT_OF_ORDER_CHUNK",
          `chunk[${streamIndex}] regressed from ledger ${prev.ledger} (eventId=${prev.eventId || "none"}) to ledger ${ev.ledger} (eventId=${ev.eventId || "none"})`,
        );
      }
      lastPerStream[streamIndex] = ev;

      if (contractFilter && ev.source !== contractFilter) {
        continue;
      }
      if (fromLedger !== undefined && ev.ledger < fromLedger) {
        continue;
      }
      if (toLedger !== undefined && ev.ledger > toLedger) {
        continue;
      }

      const nextSeq = (seqPerStream[streamIndex] ?? 0) + 1;
      seqPerStream[streamIndex] = nextSeq;
      heads[streamIndex] = {
        streamIndex,
        seq: nextSeq,
        event: ev,
      };
      return;
    }
  }

  let eventCount = 0;
  let duplicates = 0;
  let firstLedger: number | null = null;
  let lastLedger: number | null = null;
  let lastEmitted: DecodedEvent | null = null;
  const histogramCounts = new Map<string, number>();

  try {
    for (let i = 0; i < iterators.length; i++) {
      await pullNext(i);
    }

    for (;;) {
      let best: ActiveStreamHead | null = null;
      for (let i = 0; i < heads.length; i++) {
        const candidate = heads[i] ?? null;
        if (candidate === null) continue;
        if (best === null) {
          best = candidate;
          continue;
        }
        const cmp = compareReplayChunkEvents(candidate.event, best.event);
        if (
          cmp < 0 ||
          (cmp === 0 &&
            (candidate.streamIndex < best.streamIndex ||
              (candidate.streamIndex === best.streamIndex && candidate.seq < best.seq)))
        ) {
          best = candidate;
        }
      }

      if (best === null) {
        break;
      }

      const chosen = best.event;
      await pullNext(best.streamIndex);

      if (lastEmitted !== null && compareEvents(chosen, lastEmitted) < 0) {
        throw new ReplayChunkMergeError(
          "OUT_OF_ORDER_CHUNK",
          `merged stream regressed from ledger ${lastEmitted.ledger} to ledger ${chosen.ledger}`,
        );
      }

      const key = eventKey(chosen);
      if (dedupEnabled && key !== null) {
        const source = chosen.source;
        if (key === lastKeyBySource[source] || !dedupBySource[source].add(key)) {
          duplicates += 1;
          continue;
        }
        lastKeyBySource[source] = key;
      }

      lastEmitted = chosen;
      eventCount += 1;
      if (firstLedger === null) firstLedger = chosen.ledger;
      lastLedger = chosen.ledger;
      recordBoundedHistogram(histogramCounts, chosen);

      if (output) {
        const eventLine =
          JSON.stringify({ type: "event", ...chosen }, scanJsonReplacer) + "\n";
        await writeLineWithBackpressure(output, eventLine);
      }
    }

    const summary: ReplayMergedSummaryLine = {
      type: "summary",
      eventCount,
      duplicates,
      chunksMerged: opts.chunksMergedCount ?? chunks.length,
      firstLedger,
      lastLedger,
      histogram: finalizeHistogram(histogramCounts),
    };

    if (output) {
      const summaryLine = JSON.stringify(summary, scanJsonReplacer) + "\n";
      await writeLineWithBackpressure(output, summaryLine);
    }

    return summary;
  } finally {
    for (const iter of iterators) {
      if (typeof iter.return === "function") {
        try {
          await iter.return();
        } catch {
          // Ignore cleanup errors so primary failure is preserved.
        }
      }
    }
  }
}

/**
 * Byte-bounded UTF-8 line reader. Aborts immediately if any single line exceeds
 * `maxLineBytes` without waiting for a newline, preventing unbounded memory
 * allocation on malformed or hostile input files.
 */
async function* readBoundedLines(
  filePath: string,
  chunkLabel: string,
  maxLineBytes: number,
): AsyncGenerator<{ line: string; lineNumber: number }> {
  const stream = createReadStream(filePath);
  let pendingBuffers: Buffer[] = [];
  let pendingBytes = 0;
  let lineNumber = 0;

  try {
    for await (const rawChunk of stream) {
      const buf = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(String(rawChunk), "utf8");
      let offset = 0;

      while (offset < buf.length) {
        const nlIndex = buf.indexOf(0x0a, offset);
        if (nlIndex === -1) {
          const slice = buf.subarray(offset);
          if (pendingBytes + slice.length > maxLineBytes) {
            throw new ReplayChunkMergeError(
              "OVERSIZED_CHUNK_LINE",
              `${chunkLabel}:${lineNumber + 1}: line exceeds ${maxLineBytes} byte limit`,
            );
          }
          pendingBuffers.push(slice);
          pendingBytes += slice.length;
          break;
        }

        const slice = buf.subarray(offset, nlIndex);
        if (pendingBytes + slice.length > maxLineBytes) {
          throw new ReplayChunkMergeError(
            "OVERSIZED_CHUNK_LINE",
            `${chunkLabel}:${lineNumber + 1}: line exceeds ${maxLineBytes} byte limit`,
          );
        }

        let fullBuf: Buffer;
        if (pendingBuffers.length === 0) {
          fullBuf = slice;
        } else {
          pendingBuffers.push(slice);
          fullBuf = Buffer.concat(pendingBuffers, pendingBytes + slice.length);
          pendingBuffers = [];
          pendingBytes = 0;
        }

        // Strip optional trailing CR
        if (fullBuf.length > 0 && fullBuf[fullBuf.length - 1] === 0x0d) {
          fullBuf = fullBuf.subarray(0, fullBuf.length - 1);
        }

        lineNumber += 1;
        yield { line: fullBuf.toString("utf8"), lineNumber };
        offset = nlIndex + 1;
      }
    }

    if (pendingBytes > 0) {
      let fullBuf =
        pendingBuffers.length === 1
          ? pendingBuffers[0]!
          : Buffer.concat(pendingBuffers, pendingBytes);
      if (fullBuf.length > 0 && fullBuf[fullBuf.length - 1] === 0x0d) {
        fullBuf = fullBuf.subarray(0, fullBuf.length - 1);
      }
      lineNumber += 1;
      yield { line: fullBuf.toString("utf8"), lineNumber };
    }
  } catch (err) {
    if (err instanceof ReplayChunkMergeError) throw err;
    throw new ReplayChunkMergeError(
      "CHUNK_READ_ERROR",
      `cannot read chunk "${chunkLabel}": ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    stream.destroy();
  }
}

function convertScanReportToSortedEvents(json: string, chunkLabel: string): DecodedEvent[] {
  let report;
  try {
    report = reviveScanReport(json);
  } catch (err) {
    const detail = err instanceof ScanReviverError ? err.message : String(err);
    throw new ReplayChunkMergeError("MALFORMED_CHUNK", `${chunkLabel}: ${detail}`);
  }

  const events: DecodedEvent[] = [];
  for (const target of report.targets) {
    if (target.source !== "market" && target.source !== "squad") {
      throw new ReplayChunkMergeError(
        "MALFORMED_CHUNK",
        `${chunkLabel}: invalid target source "${String(target.source)}"`,
      );
    }
    for (const ev of target.events) {
      if (typeof ev.ledger !== "number" || !Number.isSafeInteger(ev.ledger) || ev.ledger < 0) {
        throw new ReplayChunkMergeError(
          "MALFORMED_CHUNK",
          `${chunkLabel}: invalid event ledger in target "${target.source}"`,
        );
      }
      events.push({
        source: target.source,
        contractId: target.contractId,
        version: DEFAULT_CONTRACT_VERSION,
        ledger: ev.ledger,
        txHash: typeof ev.txHash === "string" ? ev.txHash : "",
        at: 0,
        eventId: typeof ev.eventId === "string" ? ev.eventId : "",
        eventType: "contract",
        transactionIndex: null,
        operationIndex: null,
        inSuccessfulContractCall: null,
        payload: ev.payload,
      });
    }
  }

  return sortEvents(events);
}

async function* streamJsonlChunkForSource(
  filePath: string,
  chunkLabel: string,
  targetSource: ContractSource,
  validateAllLines: boolean,
  maxLineBytes: number,
): AsyncGenerator<DecodedEvent> {
  let prevForSource: DecodedEvent | null = null;
  for await (const { line, lineNumber } of readBoundedLines(filePath, chunkLabel, maxLineBytes)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new ReplayChunkMergeError(
        "MALFORMED_CHUNK",
        `${chunkLabel}:${lineNumber}: invalid JSON (${err instanceof Error ? err.message : String(err)})`,
      );
    }

    const decoded = parseChunkJsonObject(parsed, chunkLabel, lineNumber);
    if (decoded === null) continue;

    if (decoded.source !== targetSource) {
      if (validateAllLines) {
        // Validated schema for the other contract; its dedicated stream will yield it.
      }
      continue;
    }

    if (prevForSource !== null && compareEvents(decoded, prevForSource) < 0) {
      throw new ReplayChunkMergeError(
        "OUT_OF_ORDER_CHUNK",
        `${chunkLabel}:${lineNumber}: ${targetSource} events regressed from ledger ${prevForSource.ledger} (eventId=${prevForSource.eventId || "none"}) to ledger ${decoded.ledger} (eventId=${decoded.eventId || "none"})`,
      );
    }
    prevForSource = decoded;
    yield decoded;
  }
}

async function openChunkFileStreams(
  filePath: string,
  contractFilter: ContractSource | undefined,
  maxLineBytes: number,
): Promise<Array<AsyncIterable<DecodedEvent> | Iterable<DecodedEvent>>> {
  const chunkLabel = path.basename(filePath) || filePath;
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch (err) {
    throw new ReplayChunkMergeError(
      "CHUNK_READ_ERROR",
      `cannot access chunk "${chunkLabel}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!fileStat.isFile()) {
    throw new ReplayChunkMergeError(
      "CHUNK_READ_ERROR",
      `chunk path "${chunkLabel}" is not a regular file`,
    );
  }

  if (fileStat.size === 0) {
    return [[]];
  }

  // Inspect the first non-empty line with bounded line reading to detect
  // single-line or pretty-printed `mimir-scan-v1` JSON documents vs NDJSON.
  let firstNonEmptyLine: string | null = null;
  for await (const { line } of readBoundedLines(filePath, chunkLabel, maxLineBytes)) {
    const trimmed = line.trim();
    if (trimmed !== "") {
      firstNonEmptyLine = trimmed;
      break;
    }
  }

  if (firstNonEmptyLine === null) {
    return [[]];
  }

  let firstParsed: unknown;
  let firstLineIsCompleteJson = false;
  try {
    firstParsed = JSON.parse(firstNonEmptyLine);
    firstLineIsCompleteJson = true;
  } catch {
    firstLineIsCompleteJson = false;
  }

  if (firstLineIsCompleteJson) {
    if (
      firstParsed &&
      typeof firstParsed === "object" &&
      !Array.isArray(firstParsed) &&
      (firstParsed as { format?: unknown }).format === "mimir-scan-v1"
    ) {
      if (fileStat.size > MAX_JSON_CHUNK_FILE_BYTES) {
        throw new ReplayChunkMergeError(
          "OVERSIZED_JSON_CHUNK",
          `${chunkLabel}: mimir-scan-v1 JSON report exceeds ${MAX_JSON_CHUNK_FILE_BYTES} bytes; use JSONL chunks`,
        );
      }
      const rawJson = await readFile(filePath, "utf8");
      return [convertScanReportToSortedEvents(rawJson, chunkLabel)];
    }
  } else if (firstNonEmptyLine.startsWith("{")) {
    // Potentially a pretty-printed multi-line `mimir-scan-v1` JSON report.
    if (fileStat.size > MAX_JSON_CHUNK_FILE_BYTES) {
      throw new ReplayChunkMergeError(
        "OVERSIZED_JSON_CHUNK",
        `${chunkLabel}: non-JSONL chunk exceeds ${MAX_JSON_CHUNK_FILE_BYTES} bytes`,
      );
    }
    const rawJson = await readFile(filePath, "utf8");
    let fullParsed: unknown;
    try {
      fullParsed = JSON.parse(rawJson);
    } catch {
      // Not valid multi-line JSON either: fall through to line-by-line JSONL parser
      // so the exact line number is reported cleanly.
      fullParsed = null;
    }
    if (
      fullParsed &&
      typeof fullParsed === "object" &&
      !Array.isArray(fullParsed) &&
      (fullParsed as { format?: unknown }).format === "mimir-scan-v1"
    ) {
      return [convertScanReportToSortedEvents(rawJson, chunkLabel)];
    }
  }

  // Standard NDJSON / JSONL chunk: open per-contract streaming readers so
  // multi-contract `npm run scan -- --jsonl` files (market followed by squad)
  // merge into global canonical ledger order with O(1) memory per file.
  if (contractFilter) {
    return [streamJsonlChunkForSource(filePath, chunkLabel, contractFilter, true, maxLineBytes)];
  }

  return [
    streamJsonlChunkForSource(filePath, chunkLabel, "market", true, maxLineBytes),
    streamJsonlChunkForSource(filePath, chunkLabel, "squad", false, maxLineBytes),
  ];
}

/**
 * Merge replay/scanner chunk files from disk into a canonical streaming JSONL
 * report. When `outputFile` is provided, writes via a temporary sibling file
 * and atomically renames on completion so partial/failed merges never leave a
 * truncated report behind.
 */
export async function mergeReplayChunkFiles(
  filePaths: readonly string[],
  opts: ReplayChunkMergeOptions & { outputFile?: string | undefined } = {},
): Promise<ReplayChunkMergeResult> {
  if (!Array.isArray(filePaths) || filePaths.length === 0) {
    throw new ReplayChunkMergeError(
      "EMPTY_CHUNKS",
      "at least one chunk file path is required",
    );
  }

  const maxLineBytes = opts.maxLineBytes ?? MAX_CHUNK_LINE_BYTES;
  const streams: Array<AsyncIterable<DecodedEvent> | Iterable<DecodedEvent>> = [];
  for (const filePath of filePaths) {
    const opened = await openChunkFileStreams(filePath, opts.contract, maxLineBytes);
    streams.push(...opened);
  }

  if (!opts.outputFile) {
    return mergeReplayScanChunks(streams, {
      ...opts,
      chunksMergedCount: filePaths.length,
    });
  }

  const outDir = path.dirname(opts.outputFile);
  await mkdir(outDir, { recursive: true });
  const tmpPath = `${opts.outputFile}.${process.pid}.${Date.now()}.tmp`;
  const fileStream = createWriteStream(tmpPath, { encoding: "utf8" });

  try {
    const result = await mergeReplayScanChunks(streams, {
      ...opts,
      output: fileStream,
      chunksMergedCount: filePaths.length,
    });

    await new Promise<void>((resolve, reject) => {
      fileStream.once("error", reject);
      fileStream.end(() => resolve());
    });

    await rename(tmpPath, opts.outputFile);
    return result;
  } catch (err) {
    fileStream.destroy();
    try {
      await unlink(tmpPath);
    } catch {
      // Ignore missing temp file.
    }
    throw err;
  }
}
