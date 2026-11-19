import type { DecodedEvent } from "./decode.js";
import { eventHistogram, scanJsonReplacer } from "./events.js";
import { ArchiveMetadataConflictError, type ArchiveMetadata } from "./archive.js";

export interface ScanJsonlEventLine extends DecodedEvent {
  type: "event";
}

export interface ScanJsonlSummaryLine {
  type: "summary";
  eventCount: number;
  histogram: Record<string, number>;
}

export interface FormatScanJsonlOptions {
  /** Optional metadata associated with the scan capture. */
  metadata?: ArchiveMetadata;
  /** Expected network metadata; rejects captures with contradictory network metadata. */
  expectedNetwork?: string;
  /** Expected contractId metadata; rejects captures with contradictory contractId metadata or events. */
  expectedContractId?: string;
}

/**
 * Format decoded events as JSON Lines (NDJSON): one event line per decoded
 * event followed by a final `{ type: "summary" }` line containing the
 * histogram from {@link eventHistogram}.
 *
 * When metadata or expected network/contractId options are provided,
 * validates them before computing aggregate results.
 */
export function formatScanJsonl(
  events: readonly DecodedEvent[],
  options: FormatScanJsonlOptions = {},
): string {
  const { metadata, expectedNetwork, expectedContractId } = options;

  if (expectedNetwork !== undefined && metadata?.network !== undefined && metadata.network !== expectedNetwork) {
    throw new ArchiveMetadataConflictError(
      `Scan network "${metadata.network}" contradicts expected network "${expectedNetwork}"`,
    );
  }
  if (
    expectedContractId !== undefined &&
    metadata?.contractId !== undefined &&
    metadata.contractId !== expectedContractId
  ) {
    throw new ArchiveMetadataConflictError(
      `Scan contractId "${metadata.contractId}" contradicts expected contractId "${expectedContractId}"`,
    );
  }

  const effectiveContractId = expectedContractId ?? metadata?.contractId;
  if (effectiveContractId !== undefined) {
    for (const event of events) {
      if (event.contractId !== effectiveContractId) {
        throw new ArchiveMetadataConflictError(
          `Event contractId "${event.contractId}" contradicts expected contractId "${effectiveContractId}"`,
        );
      }
    }
  }

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
