import { createHash } from "node:crypto";
import type { DecodedEvent } from "./decode.js";
import { eventHistogram, scanJsonReplacer } from "./events.js";

export const ARCHIVE_MANIFEST_FORMAT = "mimir-archive-manifest-v1" as const;
export const ARCHIVE_HASH_ALGORITHM = "sha256" as const;

export interface ScanJsonlEventLine extends DecodedEvent {
  type: "event";
}

export interface ScanJsonlSummaryLine {
  type: "summary";
  eventCount: number;
  histogram: Record<string, number>;
}

export interface ManifestLedgerBounds {
  fromLedger: number;
  toLedger: number;
}

export interface ArchiveManifestContext {
  network: string;
  ledgerBounds: ManifestLedgerBounds;
}

export interface ArchiveManifestSegmentEntry {
  file: string;
  recordCount: number;
  startIndex: number;
  endIndex: number | null;
  recordHashes: string[];
  endChainHash: string;
}

export interface ArchiveManifest {
  format: typeof ARCHIVE_MANIFEST_FORMAT;
  algorithm: typeof ARCHIVE_HASH_ALGORITHM;
  network: string;
  ledgerBounds: ManifestLedgerBounds;
  totalRecords: number;
  genesisHash: string;
  headChainHash: string;
  rootDigest: string;
  segments: ArchiveManifestSegmentEntry[];
}

export type ManifestVerificationErrorCode =
  | "INVALID_MANIFEST"
  | "MISSING_MANIFEST"
  | "NETWORK_MISMATCH"
  | "LEDGER_BOUNDS_MISMATCH"
  | "LEDGER_OUT_OF_BOUNDS"
  | "GENESIS_DIGEST_MISMATCH"
  | "MISSING_SEGMENT"
  | "UNEXPECTED_SEGMENT"
  | "RECORD_COUNT_MISMATCH"
  | "RECORD_HASH_MISMATCH"
  | "CHAIN_HASH_MISMATCH"
  | "ROOT_DIGEST_MISMATCH";

export class ArchiveManifestVerificationError extends Error {
  readonly code: ManifestVerificationErrorCode;

  constructor(code: ManifestVerificationErrorCode, message: string) {
    super(message);
    this.name = "ArchiveManifestVerificationError";
    this.code = code;
  }
}

export interface VerifyManifestExpectations {
  expectedNetwork?: string | undefined;
  expectedLedgerBounds?: ManifestLedgerBounds | undefined;
}

function sha256Hex(payload: string): string {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

function canonicalizeValue(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString(10);
  }
  if (Array.isArray(value)) {
    return value.map(canonicalizeValue);
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      const next = obj[key];
      if (next !== undefined) {
        sorted[key] = canonicalizeValue(next);
      }
    }
    return sorted;
  }
  return value;
}

export function canonicalRecordJson(record: unknown): string {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new ArchiveManifestVerificationError(
      "INVALID_MANIFEST",
      "Archive record must be a JSON object",
    );
  }
  const { type: _ignoredType, ...rest } = record as Record<string, unknown>;
  return JSON.stringify(canonicalizeValue(rest), scanJsonReplacer);
}

export function validateManifestContext(ctx: ArchiveManifestContext): ArchiveManifestContext {
  if (!ctx || typeof ctx !== "object") {
    throw new ArchiveManifestVerificationError(
      "INVALID_MANIFEST",
      "Manifest context is required",
    );
  }
  if (typeof ctx.network !== "string" || ctx.network.trim().length === 0) {
    throw new ArchiveManifestVerificationError(
      "INVALID_MANIFEST",
      "Manifest network must be a non-empty string",
    );
  }
  const bounds = ctx.ledgerBounds;
  if (
    !bounds ||
    typeof bounds.fromLedger !== "number" ||
    !Number.isInteger(bounds.fromLedger) ||
    bounds.fromLedger < 0 ||
    typeof bounds.toLedger !== "number" ||
    !Number.isInteger(bounds.toLedger) ||
    bounds.toLedger < 0 ||
    bounds.fromLedger > bounds.toLedger
  ) {
    throw new ArchiveManifestVerificationError(
      "INVALID_MANIFEST",
      "Manifest ledgerBounds must specify non-negative integers with fromLedger <= toLedger",
    );
  }
  return {
    network: ctx.network.trim(),
    ledgerBounds: {
      fromLedger: bounds.fromLedger,
      toLedger: bounds.toLedger,
    },
  };
}

export function computeGenesisHash(ctx: ArchiveManifestContext): string {
  const normalized = validateManifestContext(ctx);
  const seed = JSON.stringify(
    canonicalizeValue({
      format: ARCHIVE_MANIFEST_FORMAT,
      network: normalized.network,
      ledgerBounds: normalized.ledgerBounds,
    }),
  );
  return sha256Hex(`mimir-archive-genesis-v1\n${seed}`);
}

export function computeRecordDigest(record: unknown): string {
  return sha256Hex(`mimir-archive-record-v1\n${canonicalRecordJson(record)}`);
}

export function advanceChainHash(
  prevChainHash: string,
  globalIndex: number,
  recordDigest: string,
): string {
  return sha256Hex(
    `mimir-archive-chain-v1\n${prevChainHash}\n${globalIndex}\n${recordDigest}`,
  );
}

export function computeRootDigest(params: {
  network: string;
  ledgerBounds: ManifestLedgerBounds;
  totalRecords: number;
  genesisHash: string;
  headChainHash: string;
  segments: readonly ArchiveManifestSegmentEntry[];
}): string {
  const summaryPayload = JSON.stringify(
    canonicalizeValue({
      format: ARCHIVE_MANIFEST_FORMAT,
      algorithm: ARCHIVE_HASH_ALGORITHM,
      network: params.network,
      ledgerBounds: params.ledgerBounds,
      totalRecords: params.totalRecords,
      genesisHash: params.genesisHash,
      headChainHash: params.headChainHash,
      segments: params.segments.map((s) => ({
        file: s.file,
        recordCount: s.recordCount,
        startIndex: s.startIndex,
        endIndex: s.endIndex,
        endChainHash: s.endChainHash,
      })),
    }),
  );
  return sha256Hex(`mimir-archive-root-v1\n${summaryPayload}`);
}

export function buildHashChainedManifestFromSegments(
  segmentsInput: ReadonlyArray<{ file: string; events: readonly DecodedEvent[] }>,
  context: ArchiveManifestContext,
): ArchiveManifest {
  const validCtx = validateManifestContext(context);
  const genesisHash = computeGenesisHash(validCtx);

  let chainHash = genesisHash;
  let globalIndex = 0;
  const segmentEntries: ArchiveManifestSegmentEntry[] = [];

  for (const seg of segmentsInput) {
    const startIndex = globalIndex;
    const recordHashes: string[] = [];

    for (let i = 0; i < seg.events.length; i++) {
      const ev = seg.events[i]!;
      if (
        typeof ev.ledger !== "number" ||
        !Number.isInteger(ev.ledger) ||
        ev.ledger < validCtx.ledgerBounds.fromLedger ||
        ev.ledger > validCtx.ledgerBounds.toLedger
      ) {
        throw new ArchiveManifestVerificationError(
          "LEDGER_OUT_OF_BOUNDS",
          `Event at ${seg.file}[${i}] has ledger ${String(ev.ledger)} outside [${validCtx.ledgerBounds.fromLedger}, ${validCtx.ledgerBounds.toLedger}]`,
        );
      }

      const recHash = computeRecordDigest(ev);
      recordHashes.push(recHash);
      chainHash = advanceChainHash(chainHash, globalIndex, recHash);
      globalIndex += 1;
    }

    segmentEntries.push({
      file: seg.file,
      recordCount: seg.events.length,
      startIndex,
      endIndex: seg.events.length > 0 ? globalIndex - 1 : null,
      recordHashes,
      endChainHash: chainHash,
    });
  }

  const rootDigest = computeRootDigest({
    network: validCtx.network,
    ledgerBounds: validCtx.ledgerBounds,
    totalRecords: globalIndex,
    genesisHash,
    headChainHash: chainHash,
    segments: segmentEntries,
  });

  return {
    format: ARCHIVE_MANIFEST_FORMAT,
    algorithm: ARCHIVE_HASH_ALGORITHM,
    network: validCtx.network,
    ledgerBounds: validCtx.ledgerBounds,
    totalRecords: globalIndex,
    genesisHash,
    headChainHash: chainHash,
    rootDigest,
    segments: segmentEntries,
  };
}

export function verifySegmentsAgainstManifest(
  segmentsInput: ReadonlyArray<{ file: string; events: readonly DecodedEvent[] }>,
  manifest: ArchiveManifest,
  expectations: VerifyManifestExpectations = {},
): DecodedEvent[] {
  if (
    !manifest ||
    typeof manifest !== "object" ||
    manifest.format !== ARCHIVE_MANIFEST_FORMAT ||
    manifest.algorithm !== ARCHIVE_HASH_ALGORITHM ||
    !Array.isArray(manifest.segments) ||
    typeof manifest.totalRecords !== "number" ||
    !Number.isInteger(manifest.totalRecords) ||
    manifest.totalRecords < 0 ||
    typeof manifest.genesisHash !== "string" ||
    typeof manifest.headChainHash !== "string" ||
    typeof manifest.rootDigest !== "string"
  ) {
    throw new ArchiveManifestVerificationError(
      "INVALID_MANIFEST",
      "Archive manifest has an invalid structure or unsupported format",
    );
  }

  const validCtx = validateManifestContext({
    network: manifest.network,
    ledgerBounds: manifest.ledgerBounds,
  });

  if (
    expectations.expectedNetwork !== undefined &&
    validCtx.network !== expectations.expectedNetwork.trim()
  ) {
    throw new ArchiveManifestVerificationError(
      "NETWORK_MISMATCH",
      `Manifest network "${validCtx.network}" does not match expected "${expectations.expectedNetwork.trim()}"`,
    );
  }

  if (expectations.expectedLedgerBounds !== undefined) {
    const expBounds = expectations.expectedLedgerBounds;
    if (
      validCtx.ledgerBounds.fromLedger !== expBounds.fromLedger ||
      validCtx.ledgerBounds.toLedger !== expBounds.toLedger
    ) {
      throw new ArchiveManifestVerificationError(
        "LEDGER_BOUNDS_MISMATCH",
        `Manifest ledgerBounds [${validCtx.ledgerBounds.fromLedger}, ${validCtx.ledgerBounds.toLedger}] do not match expected [${expBounds.fromLedger}, ${expBounds.toLedger}]`,
      );
    }
  }

  const expectedGenesis = computeGenesisHash(validCtx);
  if (manifest.genesisHash !== expectedGenesis) {
    throw new ArchiveManifestVerificationError(
      "GENESIS_DIGEST_MISMATCH",
      "Manifest genesisHash does not match bound network and ledgerBounds",
    );
  }

  // Check segment file list correspondence (missing, extra, or reordered segment files).
  const actualMap = new Map<string, readonly DecodedEvent[]>();
  for (const seg of segmentsInput) {
    actualMap.set(seg.file, seg.events);
  }
  const manifestFiles = new Set(manifest.segments.map((s) => s.file));

  for (const expectedSeg of manifest.segments) {
    if (!actualMap.has(expectedSeg.file)) {
      throw new ArchiveManifestVerificationError(
        "MISSING_SEGMENT",
        `Archive is missing manifest segment "${expectedSeg.file}"`,
      );
    }
  }
  for (const actualSeg of segmentsInput) {
    if (!manifestFiles.has(actualSeg.file)) {
      throw new ArchiveManifestVerificationError(
        "UNEXPECTED_SEGMENT",
        `Archive contains unrecorded segment "${actualSeg.file}"`,
      );
    }
  }

  let chainHash = expectedGenesis;
  let globalIndex = 0;
  const verifiedEvents: DecodedEvent[] = [];

  for (let sIdx = 0; sIdx < manifest.segments.length; sIdx++) {
    const expectedSeg = manifest.segments[sIdx]!;
    const actualSeg = segmentsInput[sIdx];
    if (!actualSeg || actualSeg.file !== expectedSeg.file) {
      throw new ArchiveManifestVerificationError(
        "CHAIN_HASH_MISMATCH",
        `Archive segment order mismatch at position ${sIdx}: expected "${expectedSeg.file}", found "${actualSeg?.file ?? "none"}"`,
      );
    }

    if (
      !Array.isArray(expectedSeg.recordHashes) ||
      expectedSeg.recordCount !== expectedSeg.recordHashes.length
    ) {
      throw new ArchiveManifestVerificationError(
        "INVALID_MANIFEST",
        `Manifest segment "${expectedSeg.file}" has inconsistent recordCount and recordHashes length`,
      );
    }

    if (actualSeg.events.length !== expectedSeg.recordCount) {
      throw new ArchiveManifestVerificationError(
        "RECORD_COUNT_MISMATCH",
        `Segment "${expectedSeg.file}" record count mismatch: expected ${expectedSeg.recordCount}, found ${actualSeg.events.length}`,
      );
    }

    if (expectedSeg.startIndex !== globalIndex) {
      throw new ArchiveManifestVerificationError(
        "CHAIN_HASH_MISMATCH",
        `Segment "${expectedSeg.file}" startIndex mismatch: expected ${globalIndex}, manifest declared ${expectedSeg.startIndex}`,
      );
    }

    for (let i = 0; i < actualSeg.events.length; i++) {
      const ev = actualSeg.events[i]!;
      if (
        typeof ev.ledger !== "number" ||
        !Number.isInteger(ev.ledger) ||
        ev.ledger < validCtx.ledgerBounds.fromLedger ||
        ev.ledger > validCtx.ledgerBounds.toLedger
      ) {
        throw new ArchiveManifestVerificationError(
          "LEDGER_OUT_OF_BOUNDS",
          `Event at ${actualSeg.file}[${i}] has ledger ${String(ev.ledger)} outside bound [${validCtx.ledgerBounds.fromLedger}, ${validCtx.ledgerBounds.toLedger}]`,
        );
      }

      const actualRecordDigest = computeRecordDigest(ev);
      const expectedRecordDigest = expectedSeg.recordHashes[i];
      if (actualRecordDigest !== expectedRecordDigest) {
        throw new ArchiveManifestVerificationError(
          "RECORD_HASH_MISMATCH",
          `Altered or reordered record at ${actualSeg.file}[${i}] (global index ${globalIndex})`,
        );
      }

      chainHash = advanceChainHash(chainHash, globalIndex, actualRecordDigest);
      globalIndex += 1;
      verifiedEvents.push(ev);
    }

    if (chainHash !== expectedSeg.endChainHash) {
      throw new ArchiveManifestVerificationError(
        "CHAIN_HASH_MISMATCH",
        `Hash chain digest mismatch at end of segment "${expectedSeg.file}"`,
      );
    }
  }

  if (globalIndex !== manifest.totalRecords) {
    throw new ArchiveManifestVerificationError(
      "RECORD_COUNT_MISMATCH",
      `Total record count mismatch: manifest=${manifest.totalRecords}, observed=${globalIndex}`,
    );
  }

  if (chainHash !== manifest.headChainHash) {
    throw new ArchiveManifestVerificationError(
      "CHAIN_HASH_MISMATCH",
      "Final headChainHash mismatch",
    );
  }

  const expectedRoot = computeRootDigest({
    network: validCtx.network,
    ledgerBounds: validCtx.ledgerBounds,
    totalRecords: globalIndex,
    genesisHash: expectedGenesis,
    headChainHash: chainHash,
    segments: manifest.segments,
  });

  if (expectedRoot !== manifest.rootDigest) {
    throw new ArchiveManifestVerificationError(
      "ROOT_DIGEST_MISMATCH",
      "Manifest rootDigest verification failed",
    );
  }

  return verifiedEvents;
}

function parseJsonlEventLines(jsonl: string, sourceLabel: string): DecodedEvent[] {
  const events: DecodedEvent[] = [];
  const lines = jsonl.split(/\r?\n/);
  for (let idx = 0; idx < lines.length; idx++) {
    const trimmed = (lines[idx] ?? "").trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new ArchiveManifestVerificationError(
        "INVALID_MANIFEST",
        `Malformed JSON at ${sourceLabel}:${idx + 1}`,
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ArchiveManifestVerificationError(
        "INVALID_MANIFEST",
        `Non-object JSON record at ${sourceLabel}:${idx + 1}`,
      );
    }
    const obj = parsed as Record<string, unknown>;
    if (obj.type === "summary") continue;
    const { type: _ignoredType, ...rest } = obj;
    events.push(rest as unknown as DecodedEvent);
  }
  return events;
}

/**
 * Format a JSONL capture together with a detached hash-chained manifest binding
 * ordered records, network, and ledger bounds.
 */
export function exportVerifiableScanJsonl(
  events: readonly DecodedEvent[],
  context: ArchiveManifestContext,
  fileLabel = "scan.jsonl",
): { jsonl: string; manifest: ArchiveManifest } {
  const manifest = buildHashChainedManifestFromSegments(
    [{ file: fileLabel, events }],
    context,
  );
  return {
    jsonl: formatScanJsonl(events),
    manifest,
  };
}

/**
 * Verify a JSONL capture against its hash-chained manifest and return the
 * verified ordered events.
 */
export function verifyScanJsonlManifest(
  jsonl: string,
  manifest: ArchiveManifest,
  expectations: VerifyManifestExpectations = {},
  fileLabel = manifest.segments[0]?.file ?? "scan.jsonl",
): DecodedEvent[] {
  const events = parseJsonlEventLines(jsonl, fileLabel);
  return verifySegmentsAgainstManifest([{ file: fileLabel, events }], manifest, expectations);
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
