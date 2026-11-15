import type { DecodedEvent } from "./decode.js";
import { eventHistogram, scanJsonReplacer } from "./events.js";

export const ARCHIVE_SCHEMA_FORMAT = "mimir-event-archive" as const;
export const SCAN_JSONL_SCHEMA_FORMAT = "mimir-scan-jsonl" as const;
export const DEFAULT_ARCHIVE_SCHEMA_VERSION = 1 as const;
export const SUPPORTED_ARCHIVE_READER_VERSIONS: readonly number[] = Object.freeze([1]);
export const SUPPORTED_ARCHIVE_WRITER_VERSIONS: readonly number[] = Object.freeze([1]);

export type ArchiveSchemaErrorCode =
  | "UNSUPPORTED_SCHEMA_VERSION"
  | "INVALID_SCHEMA_VERSION"
  | "INCOMPATIBLE_SCHEMA_FORMAT"
  | "MISSING_SCHEMA_VERSION"
  | "SCHEMA_VERSION_CONFLICT"
  | "NO_MUTUAL_SCHEMA_VERSION";

export class UnsupportedArchiveSchemaError extends Error {
  readonly code: ArchiveSchemaErrorCode;
  readonly foundVersion: unknown;
  readonly supportedVersions: readonly number[];

  constructor(params: {
    code: ArchiveSchemaErrorCode;
    message: string;
    foundVersion?: unknown;
    supportedVersions?: readonly number[];
  }) {
    super(params.message);
    this.name = "UnsupportedArchiveSchemaError";
    this.code = params.code;
    this.foundVersion = params.foundVersion;
    this.supportedVersions = params.supportedVersions ?? SUPPORTED_ARCHIVE_READER_VERSIONS;
  }
}

export interface ArchiveSchemaCapabilities {
  archiveFormat: typeof ARCHIVE_SCHEMA_FORMAT;
  jsonlFormat: typeof SCAN_JSONL_SCHEMA_FORMAT;
  readerVersions: readonly number[];
  writerVersions: readonly number[];
  defaultWriterVersion: number;
}

/**
 * Return the explicit schema formats and version numbers supported by archive
 * and JSONL readers and writers.
 */
export function getSupportedArchiveSchemaVersions(): ArchiveSchemaCapabilities {
  return {
    archiveFormat: ARCHIVE_SCHEMA_FORMAT,
    jsonlFormat: SCAN_JSONL_SCHEMA_FORMAT,
    readerVersions: SUPPORTED_ARCHIVE_READER_VERSIONS,
    writerVersions: SUPPORTED_ARCHIVE_WRITER_VERSIONS,
    defaultWriterVersion: DEFAULT_ARCHIVE_SCHEMA_VERSION,
  };
}

export interface SchemaNegotiationRequest {
  mode: "read" | "write";
  requestedVersion?: unknown;
  peerSupportedVersions?: readonly number[] | undefined;
  acceptedVersions?: readonly number[] | undefined;
}

function assertPositiveIntegerVersion(version: unknown, context: string): number {
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new UnsupportedArchiveSchemaError({
      code: "INVALID_SCHEMA_VERSION",
      foundVersion: version,
      message: `Invalid schema version in ${context}: expected positive integer, got ${JSON.stringify(version)}`,
    });
  }
  return version;
}

/**
 * Negotiate a mutually supported schema version for archive/JSONL read or write
 * operations, refusing unknown future versions without fallback guessing.
 */
export function negotiateArchiveSchemaVersion(request: SchemaNegotiationRequest): number {
  const baseSupported =
    request.mode === "write"
      ? SUPPORTED_ARCHIVE_WRITER_VERSIONS
      : SUPPORTED_ARCHIVE_READER_VERSIONS;

  let localSupported: readonly number[] = baseSupported;
  if (request.acceptedVersions !== undefined) {
    if (!Array.isArray(request.acceptedVersions) || request.acceptedVersions.length === 0) {
      throw new UnsupportedArchiveSchemaError({
        code: "INVALID_SCHEMA_VERSION",
        supportedVersions: baseSupported,
        message: "acceptedVersions must be a non-empty array of supported schema versions",
      });
    }
    for (const v of request.acceptedVersions) {
      const ver = assertPositiveIntegerVersion(v, "acceptedVersions");
      if (!baseSupported.includes(ver)) {
        throw new UnsupportedArchiveSchemaError({
          code: "UNSUPPORTED_SCHEMA_VERSION",
          foundVersion: ver,
          supportedVersions: baseSupported,
          message: `Requested acceptedVersion v${ver} is not supported (supported ${request.mode} versions: ${baseSupported.join(", ")})`,
        });
      }
    }
    localSupported = [...new Set(request.acceptedVersions)];
  }

  if (request.requestedVersion !== undefined) {
    const requested = assertPositiveIntegerVersion(
      request.requestedVersion,
      `${request.mode} schema negotiation`,
    );
    if (!localSupported.includes(requested)) {
      throw new UnsupportedArchiveSchemaError({
        code: "UNSUPPORTED_SCHEMA_VERSION",
        foundVersion: requested,
        supportedVersions: localSupported,
        message: `Unsupported ${request.mode} archive schema version v${requested} (supported: ${localSupported.map((v) => `v${v}`).join(", ")})`,
      });
    }
    if (
      request.peerSupportedVersions !== undefined &&
      !request.peerSupportedVersions.includes(requested)
    ) {
      throw new UnsupportedArchiveSchemaError({
        code: "NO_MUTUAL_SCHEMA_VERSION",
        foundVersion: requested,
        supportedVersions: localSupported,
        message: `Peer does not support requested schema version v${requested}`,
      });
    }
    return requested;
  }

  if (request.peerSupportedVersions !== undefined) {
    if (!Array.isArray(request.peerSupportedVersions) || request.peerSupportedVersions.length === 0) {
      throw new UnsupportedArchiveSchemaError({
        code: "NO_MUTUAL_SCHEMA_VERSION",
        supportedVersions: localSupported,
        message: "Peer advertised zero supported schema versions",
      });
    }
    const peerNums = request.peerSupportedVersions.map((v) =>
      assertPositiveIntegerVersion(v, "peerSupportedVersions"),
    );
    const mutual = localSupported.filter((v) => peerNums.includes(v)).sort((a, b) => b - a);
    const chosen = mutual[0];
    if (chosen === undefined) {
      throw new UnsupportedArchiveSchemaError({
        code: "NO_MUTUAL_SCHEMA_VERSION",
        foundVersion: peerNums,
        supportedVersions: localSupported,
        message: `No mutual archive schema version between local [${localSupported.join(", ")}] and peer [${peerNums.join(", ")}]`,
      });
    }
    return chosen;
  }

  return request.mode === "write"
    ? DEFAULT_ARCHIVE_SCHEMA_VERSION
    : (localSupported[localSupported.length - 1] ?? DEFAULT_ARCHIVE_SCHEMA_VERSION);
}

export interface ScanJsonlSchemaLine {
  type: "schema";
  format: typeof SCAN_JSONL_SCHEMA_FORMAT;
  schemaVersion: number;
}

export interface ScanJsonlEventLine extends DecodedEvent {
  type: "event";
  schemaVersion?: number | undefined;
}

export interface ScanJsonlSummaryLine {
  type: "summary";
  eventCount: number;
  histogram: Record<string, number>;
  schemaVersion?: number | undefined;
}

export interface FormatScanJsonlOptions {
  schemaVersion?: number | undefined;
}

export interface ReadScanJsonlSchemaOptions {
  acceptedVersions?: readonly number[] | undefined;
  requireExplicitVersion?: boolean | undefined;
}

export interface ParsedVersionedScanJsonl {
  negotiatedVersion: number;
  explicitVersionFound: boolean;
  events: DecodedEvent[];
  summary: ScanJsonlSummaryLine | null;
}

const ALLOWED_FORMATS: ReadonlySet<string> = new Set([
  ARCHIVE_SCHEMA_FORMAT,
  SCAN_JSONL_SCHEMA_FORMAT,
  "mimir-event-archive-v1",
  "mimir-scan-jsonl-v1",
]);

function extractExplicitRecordVersion(
  record: Record<string, unknown>,
  context: string,
): number | null {
  if (record.format !== undefined) {
    if (typeof record.format !== "string" || !ALLOWED_FORMATS.has(record.format)) {
      const trailingVer =
        typeof record.format === "string" ? /-v(\d+)$/.exec(record.format) : null;
      if (trailingVer && trailingVer[1]) {
        const parsedVer = Number.parseInt(trailingVer[1], 10);
        if (parsedVer !== 1) {
          throw new UnsupportedArchiveSchemaError({
            code: "UNSUPPORTED_SCHEMA_VERSION",
            foundVersion: parsedVer,
            message: `Unsupported schema format "${record.format}" (v${parsedVer}) at ${context}`,
          });
        }
      }
      throw new UnsupportedArchiveSchemaError({
        code: "INCOMPATIBLE_SCHEMA_FORMAT",
        foundVersion: record.format,
        message: `Incompatible archive schema format ${JSON.stringify(record.format)} at ${context}`,
      });
    }
  }

  const rawVer = record.schemaVersion ?? (record.type === "schema" ? record.version : undefined);
  if (rawVer === undefined) {
    if (record.type === "schema") {
      throw new UnsupportedArchiveSchemaError({
        code: "INVALID_SCHEMA_VERSION",
        message: `Schema header at ${context} is missing integer "schemaVersion"`,
      });
    }
    return null;
  }

  return assertPositiveIntegerVersion(rawVer, context);
}

function validateStrictV1EventRecord(record: Record<string, unknown>, context: string): DecodedEvent {
  if (
    (record.source !== "market" && record.source !== "squad") ||
    typeof record.contractId !== "string" ||
    record.contractId.trim().length === 0 ||
    typeof record.ledger !== "number" ||
    !Number.isInteger(record.ledger) ||
    typeof record.txHash !== "string" ||
    record.txHash.trim().length === 0 ||
    typeof record.eventId !== "string" ||
    record.eventId.trim().length === 0 ||
    !record.payload ||
    typeof record.payload !== "object" ||
    Array.isArray(record.payload) ||
    typeof (record.payload as Record<string, unknown>).name !== "string"
  ) {
    throw new Error(`Invalid v1 event record structure at ${context}`);
  }
  const { type: _ignoredType, schemaVersion: _ignoredVer, ...rest } = record;
  return rest as unknown as DecodedEvent;
}

/**
 * Parse a JSONL capture with explicit schema version negotiation, refusing
 * unknown future versions without best-effort field guessing.
 */
export function parseVersionedScanJsonl(
  jsonl: string,
  options: ReadScanJsonlSchemaOptions = {},
): ParsedVersionedScanJsonl {
  const defaultNegotiated = negotiateArchiveSchemaVersion({
    mode: "read",
    acceptedVersions: options.acceptedVersions,
  });

  const rawLines = jsonl.split(/\r?\n/);
  const parsedRecords: Array<{ line: number; obj: Record<string, unknown> }> = [];
  let explicitVersion: number | null = null;

  // Pass 1: inspect all schema declarations before decoding event fields so
  // unknown future versions are refused up front with zero field guessing.
  for (let idx = 0; idx < rawLines.length; idx++) {
    const trimmed = (rawLines[idx] ?? "").trim();
    if (!trimmed) continue;
    const lineNum = idx + 1;
    const context = `line ${lineNum}`;

    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Expected JSON object record at ${context}`);
    }
    const obj = parsed as Record<string, unknown>;
    const declared = extractExplicitRecordVersion(obj, context);
    if (declared !== null) {
      const checked = negotiateArchiveSchemaVersion({
        mode: "read",
        requestedVersion: declared,
        acceptedVersions: options.acceptedVersions,
      });
      if (explicitVersion !== null && explicitVersion !== checked) {
        throw new UnsupportedArchiveSchemaError({
          code: "SCHEMA_VERSION_CONFLICT",
          foundVersion: checked,
          message: `Conflicting schema versions v${explicitVersion} and v${checked} at ${context}`,
        });
      }
      explicitVersion = checked;
    }
    parsedRecords.push({ line: lineNum, obj });
  }

  if (options.requireExplicitVersion && explicitVersion === null) {
    throw new UnsupportedArchiveSchemaError({
      code: "MISSING_SCHEMA_VERSION",
      message: "JSONL capture is missing an explicit schemaVersion header",
    });
  }

  const negotiatedVersion = explicitVersion ?? defaultNegotiated;
  const events: DecodedEvent[] = [];
  let summary: ScanJsonlSummaryLine | null = null;

  for (const { line, obj } of parsedRecords) {
    if (obj.type === "schema") continue;
    if (obj.type === "summary") {
      summary = obj as unknown as ScanJsonlSummaryLine;
      continue;
    }
    events.push(validateStrictV1EventRecord(obj, `line ${line}`));
  }

  return {
    negotiatedVersion,
    explicitVersionFound: explicitVersion !== null,
    events,
    summary,
  };
}

/**
 * Format decoded events as JSON Lines (NDJSON): one event line per decoded
 * event followed by a final `{ type: "summary" }` line containing the
 * histogram from {@link eventHistogram}.
 *
 * When `options.schemaVersion` is supplied, validates the writer version and
 * prepends an explicit `{ type: "schema" }` header record.
 */
export function formatScanJsonl(
  events: readonly DecodedEvent[],
  options?: FormatScanJsonlOptions,
): string {
  const lines: string[] = [];
  let negotiatedWriterVersion: number | null = null;

  if (options?.schemaVersion !== undefined) {
    negotiatedWriterVersion = negotiateArchiveSchemaVersion({
      mode: "write",
      requestedVersion: options.schemaVersion,
    });
    const header: ScanJsonlSchemaLine = {
      type: "schema",
      format: SCAN_JSONL_SCHEMA_FORMAT,
      schemaVersion: negotiatedWriterVersion,
    };
    lines.push(JSON.stringify(header, scanJsonReplacer));
  }

  for (const event of events) {
    lines.push(JSON.stringify({ type: "event", ...event }, scanJsonReplacer));
  }

  const summary: ScanJsonlSummaryLine = {
    type: "summary",
    eventCount: events.length,
    histogram: eventHistogram([...events]),
    ...(negotiatedWriterVersion !== null ? { schemaVersion: negotiatedWriterVersion } : {}),
  };
  lines.push(JSON.stringify(summary, scanJsonReplacer));
  return lines.join("\n") + "\n";
}
