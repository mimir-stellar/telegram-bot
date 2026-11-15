import type { ContractSource, DecodedEvent } from "./decode.js";
import { eventHistogram, scanJsonReplacer } from "./events.js";

export type ArchiveMetadataErrorCode =
  | "INVALID_METADATA"
  | "MISSING_METADATA"
  | "NETWORK_MISMATCH"
  | "CONTRACT_MISMATCH"
  | "DUPLICATE_CONTRACT_ROLE";

export class ArchiveMetadataError extends Error {
  readonly code: ArchiveMetadataErrorCode;

  constructor(code: ArchiveMetadataErrorCode, message: string) {
    super(message);
    this.name = "ArchiveMetadataError";
    this.code = code;
  }
}

export interface CaptureMetadata {
  network?: string | undefined;
  contracts?: Partial<Record<ContractSource, string>> | undefined;
}

export interface NormalizedCaptureMetadata {
  network: string | null;
  contracts: Partial<Record<ContractSource, string>>;
}

export interface ScanJsonlMetaLine {
  type: "meta";
  format: "mimir-scan-jsonl-v1";
  network?: string | undefined;
  contracts?: Partial<Record<ContractSource, string>> | undefined;
}

export interface ScanJsonlEventLine extends DecodedEvent {
  type: "event";
}

export interface ScanJsonlSummaryLine {
  type: "summary";
  eventCount: number;
  histogram: Record<string, number>;
  network?: string | undefined;
  contracts?: Partial<Record<ContractSource, string>> | undefined;
}

const VALID_SOURCES: ReadonlySet<string> = new Set<ContractSource>(["market", "squad"]);

function assertValidSource(source: string, context: string): asserts source is ContractSource {
  if (!VALID_SOURCES.has(source)) {
    throw new ArchiveMetadataError(
      "INVALID_METADATA",
      `Unsupported contract source "${source}" in ${context}`,
    );
  }
}

export function normalizeCaptureMetadata(
  meta: CaptureMetadata | undefined,
  context = "capture metadata",
): NormalizedCaptureMetadata {
  if (!meta) {
    return { network: null, contracts: {} };
  }
  if (typeof meta !== "object" || Array.isArray(meta)) {
    throw new ArchiveMetadataError("INVALID_METADATA", `${context} must be an object`);
  }

  let network: string | null = null;
  if (meta.network !== undefined) {
    if (typeof meta.network !== "string" || meta.network.trim().length === 0) {
      throw new ArchiveMetadataError(
        "INVALID_METADATA",
        `${context} network must be a non-empty string`,
      );
    }
    network = meta.network.trim();
  }

  const contracts: Partial<Record<ContractSource, string>> = {};
  if (meta.contracts !== undefined) {
    if (!meta.contracts || typeof meta.contracts !== "object" || Array.isArray(meta.contracts)) {
      throw new ArchiveMetadataError(
        "INVALID_METADATA",
        `${context} contracts must be an object mapping contract sources to contract IDs`,
      );
    }
    const seenIds = new Map<string, ContractSource>();
    for (const [rawSource, rawId] of Object.entries(meta.contracts)) {
      if (rawId === undefined) continue;
      assertValidSource(rawSource, context);
      if (typeof rawId !== "string" || rawId.trim().length === 0) {
        throw new ArchiveMetadataError(
          "INVALID_METADATA",
          `${context} contract ID for "${rawSource}" must be a non-empty string`,
        );
      }
      const trimmedId = rawId.trim();
      const existingSource = seenIds.get(trimmedId);
      if (existingSource && existingSource !== rawSource) {
        throw new ArchiveMetadataError(
          "DUPLICATE_CONTRACT_ROLE",
          `Contradictory contract metadata in ${context}: "${existingSource}" and "${rawSource}" both map to "${trimmedId}"`,
        );
      }
      seenIds.set(trimmedId, rawSource);
      contracts[rawSource] = trimmedId;
    }
  }

  return { network, contracts };
}

export function mergeConsistentMetadata(
  current: NormalizedCaptureMetadata,
  incoming: NormalizedCaptureMetadata,
  context: string,
): NormalizedCaptureMetadata {
  let network = current.network;
  if (incoming.network !== null) {
    if (network !== null && network !== incoming.network) {
      throw new ArchiveMetadataError(
        "NETWORK_MISMATCH",
        `Contradictory network metadata in ${context}: expected "${network}", got "${incoming.network}"`,
      );
    }
    network = incoming.network;
  }

  const contracts: Partial<Record<ContractSource, string>> = { ...current.contracts };
  for (const source of ["market", "squad"] as const) {
    const nextId = incoming.contracts[source];
    if (nextId === undefined) continue;

    const existingId = contracts[source];
    if (existingId !== undefined && existingId !== nextId) {
      throw new ArchiveMetadataError(
        "CONTRACT_MISMATCH",
        `Contradictory "${source}" contract metadata in ${context}: expected "${existingId}", got "${nextId}"`,
      );
    }

    const otherSource: ContractSource = source === "market" ? "squad" : "market";
    const otherId = contracts[otherSource];
    if (otherId !== undefined && otherId === nextId) {
      throw new ArchiveMetadataError(
        "DUPLICATE_CONTRACT_ROLE",
        `Contradictory contract role metadata in ${context}: "${source}" contract "${nextId}" collides with "${otherSource}"`,
      );
    }

    contracts[source] = nextId;
  }

  return { network, contracts };
}

export function extractEventMetadata(
  record: unknown,
  context: string,
): NormalizedCaptureMetadata {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new ArchiveMetadataError("INVALID_METADATA", `${context} event must be an object`);
  }
  const obj = record as Record<string, unknown>;
  const rawSource = obj.source;
  const rawContractId = obj.contractId;
  if (typeof rawSource !== "string") {
    throw new ArchiveMetadataError(
      "INVALID_METADATA",
      `${context} event is missing a valid string "source"`,
    );
  }
  assertValidSource(rawSource, context);

  if (typeof rawContractId !== "string" || rawContractId.trim().length === 0) {
    throw new ArchiveMetadataError(
      "INVALID_METADATA",
      `${context} event for "${rawSource}" is missing a non-empty "contractId"`,
    );
  }

  let network: string | null = null;
  if (obj.network !== undefined) {
    if (typeof obj.network !== "string" || obj.network.trim().length === 0) {
      throw new ArchiveMetadataError(
        "INVALID_METADATA",
        `${context} event has an invalid "network" field`,
      );
    }
    network = obj.network.trim();
  }

  return {
    network,
    contracts: { [rawSource]: rawContractId.trim() },
  };
}

/**
 * Format decoded events as JSON Lines (NDJSON): one event line per decoded
 * event followed by a final `{ type: "summary" }` line containing the
 * histogram from {@link eventHistogram}.
 *
 * When `metadata` is supplied, validates network and contract consistency
 * across all events before serializing and emits a leading `{ type: "meta" }`
 * record plus summary metadata fields.
 */
export function formatScanJsonl(
  events: readonly DecodedEvent[],
  metadata?: CaptureMetadata,
): string {
  let resolved = normalizeCaptureMetadata(metadata, "formatScanJsonl metadata");
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (!ev) continue;
    const evMeta = extractEventMetadata(ev, `event[${i}]`);
    resolved = mergeConsistentMetadata(resolved, evMeta, `event[${i}]`);
  }

  const lines: string[] = [];
  if (metadata !== undefined) {
    const metaLine: ScanJsonlMetaLine = {
      type: "meta",
      format: "mimir-scan-jsonl-v1",
      ...(resolved.network !== null ? { network: resolved.network } : {}),
      ...(Object.keys(resolved.contracts).length > 0 ? { contracts: resolved.contracts } : {}),
    };
    lines.push(JSON.stringify(metaLine, scanJsonReplacer));
  }

  for (const event of events) {
    lines.push(JSON.stringify({ type: "event", ...event }, scanJsonReplacer));
  }

  const summary: ScanJsonlSummaryLine = {
    type: "summary",
    eventCount: events.length,
    histogram: eventHistogram([...events]),
    ...(metadata !== undefined && resolved.network !== null ? { network: resolved.network } : {}),
    ...(metadata !== undefined && Object.keys(resolved.contracts).length > 0
      ? { contracts: resolved.contracts }
      : {}),
  };
  lines.push(JSON.stringify(summary, scanJsonReplacer));
  return lines.join("\n") + "\n";
}

export interface ValidateScanJsonlOptions {
  expected?: CaptureMetadata | undefined;
  requireNetwork?: boolean | undefined;
}

export interface ParsedScanJsonlCapture {
  metadata: NormalizedCaptureMetadata;
  events: DecodedEvent[];
  summary: ScanJsonlSummaryLine | null;
}

/**
 * Parse and validate all metadata across a JSONL capture before returning
 * events. Rejects contradictory network or contract metadata across `meta`,
 * `event`, and `summary` records.
 */
export function parseScanJsonlCapture(
  jsonl: string,
  options: ValidateScanJsonlOptions = {},
): ParsedScanJsonlCapture {
  let resolved = normalizeCaptureMetadata(options.expected, "expected metadata");
  let captureMeta: NormalizedCaptureMetadata = { network: null, contracts: {} };
  const events: DecodedEvent[] = [];
  let summary: ScanJsonlSummaryLine | null = null;

  const rawLines = jsonl.split(/\r?\n/);
  for (let idx = 0; idx < rawLines.length; idx++) {
    const trimmed = (rawLines[idx] ?? "").trim();
    if (!trimmed) continue;
    const lineLabel = `JSONL line ${idx + 1}`;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new ArchiveMetadataError(
        "INVALID_METADATA",
        `Malformed JSON at ${lineLabel}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ArchiveMetadataError("INVALID_METADATA", `Non-object record at ${lineLabel}`);
    }

    const record = parsed as Record<string, unknown>;
    if (record.type === "meta") {
      const meta = normalizeCaptureMetadata(
        {
          network: record.network as string | undefined,
          contracts: record.contracts as Partial<Record<ContractSource, string>> | undefined,
        },
        lineLabel,
      );
      captureMeta = mergeConsistentMetadata(captureMeta, meta, lineLabel);
      resolved = mergeConsistentMetadata(resolved, meta, lineLabel);
      continue;
    }

    if (record.type === "summary") {
      if (record.network !== undefined || record.contracts !== undefined) {
        const meta = normalizeCaptureMetadata(
          {
            network: record.network as string | undefined,
            contracts: record.contracts as Partial<Record<ContractSource, string>> | undefined,
          },
          lineLabel,
        );
        captureMeta = mergeConsistentMetadata(captureMeta, meta, lineLabel);
        resolved = mergeConsistentMetadata(resolved, meta, lineLabel);
      }
      summary = record as unknown as ScanJsonlSummaryLine;
      continue;
    }

    const evMeta = extractEventMetadata(record, lineLabel);
    captureMeta = mergeConsistentMetadata(captureMeta, evMeta, lineLabel);
    resolved = mergeConsistentMetadata(resolved, evMeta, lineLabel);

    const { type: _ignoredType, ...rest } = record;
    events.push(rest as unknown as DecodedEvent);
  }

  if (options.requireNetwork && captureMeta.network === null && resolved.network === null) {
    throw new ArchiveMetadataError(
      "MISSING_METADATA",
      "JSONL capture is missing required network metadata",
    );
  }

  return { metadata: resolved, events, summary };
}

/**
 * Iterate events from a JSONL capture only after validating all metadata across
 * the entire capture so contradictory captures fail before yielding any event.
 */
export function* iterateScanJsonlEvents(
  jsonl: string,
  options: ValidateScanJsonlOptions = {},
): Generator<DecodedEvent, void, unknown> {
  const parsed = parseScanJsonlCapture(jsonl, options);
  for (const event of parsed.events) {
    yield event;
  }
}
