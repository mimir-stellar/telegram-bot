import type { DecodedEvent } from "./decode.js";
import { eventHistogram, scanJsonReplacer } from "./events.js";
import { validateLedgerRange, type LedgerRange } from "./ledger-range.js";

/** Default maximum byte length of a single JSONL record (excluding line ending). */
export const DEFAULT_MAX_JSONL_LINE_BYTES = 64 * 1024; // 64 KiB

/** Default chunk size in bytes when streaming JSONL files from disk. */
export const DEFAULT_JSONL_CHUNK_BYTES = 64 * 1024; // 64 KiB

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
  format: string;
  mode: "read" | "write";
  requestedVersion?: unknown;
  peerSupportedVersions?: readonly number[];
  acceptedVersions?: readonly number[];
}

function assertPositiveIntegerVersion(version: unknown, context: string): number {
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new UnsupportedArchiveSchemaError({
      code: "INVALID_SCHEMA_VERSION",
      foundVersion: version,
      message: `Invalid schema version in ${context}: expected a positive integer`,
    });
  }
  return version;
}

function supportedVersionsFor(mode: "read" | "write"): readonly number[] {
  return mode === "read"
    ? SUPPORTED_ARCHIVE_READER_VERSIONS
    : SUPPORTED_ARCHIVE_WRITER_VERSIONS;
}

function assertKnownFormat(format: string): void {
  if (format === ARCHIVE_SCHEMA_FORMAT || format === SCAN_JSONL_SCHEMA_FORMAT) return;

  const versionSuffix = /-v(\d+)$/.exec(format);
  if (versionSuffix?.[1] !== undefined) {
    const version = Number(versionSuffix[1]);
    if (!SUPPORTED_ARCHIVE_READER_VERSIONS.includes(version)) {
      throw new UnsupportedArchiveSchemaError({
        code: "UNSUPPORTED_SCHEMA_VERSION",
        foundVersion: version,
        message: `Unsupported archive schema format version v${version}`,
      });
    }
  }
  throw new UnsupportedArchiveSchemaError({
    code: "INCOMPATIBLE_SCHEMA_FORMAT",
    foundVersion: format,
    message: `Incompatible archive schema format "${format}"`,
  });
}

export function negotiateArchiveSchemaVersion(
  request: SchemaNegotiationRequest,
): number {
  assertKnownFormat(request.format);
  const baseSupported = supportedVersionsFor(request.mode);
  let localSupported = baseSupported;

  if (request.acceptedVersions !== undefined) {
    if (!Array.isArray(request.acceptedVersions) || request.acceptedVersions.length === 0) {
      throw new UnsupportedArchiveSchemaError({
        code: "INVALID_SCHEMA_VERSION",
        supportedVersions: baseSupported,
        message: "acceptedVersions must be a non-empty array of supported schema versions",
      });
    }
    for (const version of request.acceptedVersions) {
      const accepted = assertPositiveIntegerVersion(version, "acceptedVersions");
      if (!baseSupported.includes(accepted)) {
        throw new UnsupportedArchiveSchemaError({
          code: "UNSUPPORTED_SCHEMA_VERSION",
          foundVersion: accepted,
          supportedVersions: baseSupported,
          message: `Unsupported accepted schema version v${accepted}`,
        });
      }
    }
    localSupported = [...new Set(request.acceptedVersions)];
  }

  if (request.requestedVersion !== undefined) {
    const requested = assertPositiveIntegerVersion(
      request.requestedVersion,
      `${request.mode} negotiation`,
    );
    if (!localSupported.includes(requested)) {
      throw new UnsupportedArchiveSchemaError({
        code: "UNSUPPORTED_SCHEMA_VERSION",
        foundVersion: requested,
        supportedVersions: localSupported,
        message: `Unsupported ${request.mode} archive schema version v${requested}`,
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
        message: `Peer does not support requested archive schema version v${requested}`,
      });
    }
    return requested;
  }

  if (request.peerSupportedVersions !== undefined) {
    if (
      !Array.isArray(request.peerSupportedVersions) ||
      request.peerSupportedVersions.length === 0
    ) {
      throw new UnsupportedArchiveSchemaError({
        code: "NO_MUTUAL_SCHEMA_VERSION",
        supportedVersions: localSupported,
        message: "Peer advertised no supported archive schema versions",
      });
    }
    const peerVersions = request.peerSupportedVersions.map((version) =>
      assertPositiveIntegerVersion(version, "peerSupportedVersions"),
    );
    const common = localSupported.filter((version) => peerVersions.includes(version));
    if (common.length === 0) {
      throw new UnsupportedArchiveSchemaError({
        code: "NO_MUTUAL_SCHEMA_VERSION",
        foundVersion: peerVersions,
        supportedVersions: localSupported,
        message: "No mutually supported archive schema version",
      });
    }
    return Math.max(...common);
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
}

export interface ScanJsonlSummaryLine {
  type: "summary";
  eventCount: number;
  histogram: Record<string, number>;
}

export interface FormatScanJsonlOptions {
  schemaVersion?: number;
}

export interface ReadScanJsonlSchemaOptions {
  acceptedVersions?: readonly number[];
  requireExplicitVersion?: boolean;
}

export interface ParsedScanJsonl {
  schemaVersion: number;
  explicitVersionFound: boolean;
  events: DecodedEvent[];
  summary: ScanJsonlSummaryLine | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isDecodedEventRecord(value: unknown): value is DecodedEvent {
  if (!isRecord(value) || !isRecord(value.payload)) return false;
  return (
    (value.source === "market" || value.source === "squad") &&
    typeof value.contractId === "string" &&
    typeof value.version === "string" &&
    typeof value.ledger === "number" &&
    typeof value.txHash === "string" &&
    typeof value.at === "number" &&
    typeof value.eventId === "string" &&
    typeof value.eventType === "string"
  );
}

function isScanJsonlSummaryLine(value: unknown): value is ScanJsonlSummaryLine {
  if (!isRecord(value) || value.type !== "summary" || typeof value.eventCount !== "number") {
    return false;
  }
  if (!isRecord(value.histogram)) return false;
  return Object.values(value.histogram).every((count) => typeof count === "number");
}

/**
 * Format decoded events as canonical LF (`\n`)-delimited JSON Lines (NDJSON):
 * one event line per decoded event followed by a final `{ type: "summary" }`
 * line containing the histogram from {@link eventHistogram}, with a trailing
 * `\n` regardless of host operating system.
 */
export function formatScanJsonl(
  events: readonly DecodedEvent[],
  options: FormatScanJsonlOptions = {},
): string {
  const lines: string[] = [];
  if (options.schemaVersion !== undefined) {
    const schemaVersion = negotiateArchiveSchemaVersion({
      format: SCAN_JSONL_SCHEMA_FORMAT,
      mode: "write",
      requestedVersion: options.schemaVersion,
    });
    const schema: ScanJsonlSchemaLine = {
      type: "schema",
      format: SCAN_JSONL_SCHEMA_FORMAT,
      schemaVersion,
    };
    lines.push(JSON.stringify(schema));
  }
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

export function parseScanJsonl(
  input: string,
  options: ReadScanJsonlSchemaOptions = {},
): ParsedScanJsonl {
  const events: DecodedEvent[] = [];
  let summary: ScanJsonlSummaryLine | null = null;
  let explicitVersionFound = false;
  let schemaVersion: number = DEFAULT_ARCHIVE_SCHEMA_VERSION;
  let recordCount = 0;

  for (const [index, rawLine] of input.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;

    let record: unknown;
    try {
      record = JSON.parse(line) as unknown;
    } catch {
      throw new Error(`Malformed scan JSONL record at line ${index + 1}`);
    }
    if (!isRecord(record)) {
      throw new Error(`Malformed scan JSONL record at line ${index + 1}`);
    }

    if (recordCount === 0 && record.type === "schema") {
      if (typeof record.format !== "string") {
        throw new UnsupportedArchiveSchemaError({
          code: "INCOMPATIBLE_SCHEMA_FORMAT",
          foundVersion: record.format,
          message: "Scan JSONL schema header must include a format",
        });
      }
      if (record.schemaVersion === undefined) {
        throw new UnsupportedArchiveSchemaError({
          code: "INVALID_SCHEMA_VERSION",
          message: "Scan JSONL schema header must declare a schemaVersion",
        });
      }
      schemaVersion = negotiateArchiveSchemaVersion({
        format: record.format,
        mode: "read",
        requestedVersion: record.schemaVersion,
        acceptedVersions: options.acceptedVersions,
      });
      if (record.format !== SCAN_JSONL_SCHEMA_FORMAT) {
        throw new UnsupportedArchiveSchemaError({
          code: "INCOMPATIBLE_SCHEMA_FORMAT",
          foundVersion: record.format,
          message: `Incompatible scan JSONL schema format "${record.format}"`,
        });
      }
      explicitVersionFound = true;
      recordCount += 1;
      continue;
    }

    if (record.type === "schema") {
      throw new Error(`Unexpected scan JSONL schema record at line ${index + 1}`);
    }
    if (record.type === "event") {
      const { type: _type, ...event } = record;
      if (!isDecodedEventRecord(event)) {
        throw new Error(`Malformed scan JSONL event at line ${index + 1}`);
      }
      events.push(event);
    } else if (record.type === "summary") {
      if (summary !== null || !isScanJsonlSummaryLine(record)) {
        throw new Error(`Malformed scan JSONL summary at line ${index + 1}`);
      }
      summary = record;
    } else {
      throw new Error(`Unknown scan JSONL record type at line ${index + 1}`);
    }
    recordCount += 1;
  }

  if (!explicitVersionFound) {
    schemaVersion = negotiateArchiveSchemaVersion({
      format: SCAN_JSONL_SCHEMA_FORMAT,
      mode: "read",
      requestedVersion: DEFAULT_ARCHIVE_SCHEMA_VERSION,
      acceptedVersions: options.acceptedVersions,
    });
  }

  if (options.requireExplicitVersion && !explicitVersionFound) {
    throw new UnsupportedArchiveSchemaError({
      code: "MISSING_SCHEMA_VERSION",
      message: "Scan JSONL input does not declare an explicit schema version",
    });
  }

  return { schemaVersion, explicitVersionFound, events, summary };
}
