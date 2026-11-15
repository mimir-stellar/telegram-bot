import { open, mkdir, readdir, readFile, rename, unlink, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { eventHistogram, scanJsonReplacer } from "./events.js";
import { dedupeEvents, sortEvents, type ContractSource, type DecodedEvent } from "./decode.js";
import {
  ArchiveMetadataError,
  extractEventMetadata,
  mergeConsistentMetadata,
  normalizeCaptureMetadata,
  parseScanJsonlCapture,
  type ArchiveMetadataErrorCode,
  type CaptureMetadata,
  type NormalizedCaptureMetadata,
} from "./scan-jsonl.js";

export {
  ArchiveMetadataError,
  type ArchiveMetadataErrorCode,
  type CaptureMetadata,
  type NormalizedCaptureMetadata,
};

export const ARCHIVE_METADATA_FILENAME = "archive-metadata.json";

export interface ArchiveMetadataFile {
  format: "mimir-archive-meta-v1";
  network: string | null;
  contracts: Partial<Record<ContractSource, string>>;
}

export interface EventArchiveOptions {
  dir: string;
  maxBytes?: number;
  maxFiles?: number;
  metadata?: CaptureMetadata;
}

export interface EventArchive {
  append(events: readonly DecodedEvent[]): Promise<void>;
  close(): Promise<void>;
}

export interface ReadArchiveOptions {
  expected?: CaptureMetadata | undefined;
  requireNetwork?: boolean | undefined;
}

export interface VerifiedArchive {
  metadata: NormalizedCaptureMetadata;
  events: AsyncIterable<DecodedEvent>;
}

export type OfflineCaptureSource =
  | {
      id?: string | undefined;
      dir: string;
      metadata?: CaptureMetadata | undefined;
    }
  | {
      id?: string | undefined;
      jsonl: string;
      metadata?: CaptureMetadata | undefined;
    };

export interface OfflineAggregateOptions {
  expected?: CaptureMetadata | undefined;
  requireNetwork?: boolean | undefined;
  onConflict?: "exclude" | "throw" | undefined;
}

export interface RejectedCaptureSummary {
  id: string;
  code: ArchiveMetadataErrorCode;
  message: string;
}

export interface OfflineAggregateResult {
  metadata: NormalizedCaptureMetadata;
  events: DecodedEvent[];
  eventCount: number;
  histogram: Record<string, number>;
  ledgerRange: { minLedger: number; maxLedger: number } | null;
  acceptedCaptures: string[];
  rejectedCaptures: RejectedCaptureSummary[];
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MiB
const DEFAULT_MAX_FILES = 10;
const FILE_MODE = 0o600;

function formatArchiveFilename(index: number, timestamp: number): string {
  const ts = new Date(timestamp).toISOString().replace(/[:.]/g, "-");
  const idx = String(index).padStart(6, "0");
  return `events-${ts}-${idx}.jsonl`;
}

async function readMetadataFileIfExists(dir: string): Promise<NormalizedCaptureMetadata | null> {
  const metaPath = path.join(dir, ARCHIVE_METADATA_FILENAME);
  let raw: string;
  try {
    raw = await readFile(metaPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ArchiveMetadataError(
      "INVALID_METADATA",
      `Malformed JSON in ${ARCHIVE_METADATA_FILENAME}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ArchiveMetadataError(
      "INVALID_METADATA",
      `${ARCHIVE_METADATA_FILENAME} must contain a JSON object`,
    );
  }

  const obj = parsed as Record<string, unknown>;
  if (obj.format !== "mimir-archive-meta-v1") {
    throw new ArchiveMetadataError(
      "INVALID_METADATA",
      `Unsupported ${ARCHIVE_METADATA_FILENAME} format "${String(obj.format ?? "undefined")}"`,
    );
  }

  return normalizeCaptureMetadata(
    {
      network: obj.network === null ? undefined : (obj.network as string | undefined),
      contracts: obj.contracts as Partial<Record<ContractSource, string>> | undefined,
    },
    ARCHIVE_METADATA_FILENAME,
  );
}

async function writeMetadataFileAtomic(
  dir: string,
  metadata: NormalizedCaptureMetadata,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const metaPath = path.join(dir, ARCHIVE_METADATA_FILENAME);
  const tmpPath = `${metaPath}.${process.pid}.${Date.now()}.tmp`;
  const payload: ArchiveMetadataFile = {
    format: "mimir-archive-meta-v1",
    network: metadata.network,
    contracts: metadata.contracts,
  };
  try {
    await writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf8",
      mode: FILE_MODE,
    });
    try {
      await chmod(tmpPath, FILE_MODE);
    } catch {
      // ignore on filesystems without POSIX permissions
    }
    await rename(tmpPath, metaPath);
  } catch (err) {
    try {
      await unlink(tmpPath);
    } catch {
      // ignore cleanup error
    }
    throw err;
  }
}

export function createEventArchive(options: EventArchiveOptions): EventArchive {
  const { dir } = options;
  const maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_MAX_BYTES);
  const maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES);
  const hasExplicitMetadata = options.metadata !== undefined;
  let trackedMetadata = normalizeCaptureMetadata(options.metadata, "EventArchiveOptions.metadata");
  let metadataInitialized = false;

  let currentHandle: any = null;
  let currentFilePath: string | null = null;
  let currentSize = 0;
  let fileIndex = 0;
  let closed = false;

  let queue: Promise<void> = Promise.resolve();

  async function ensureMetadataChecked(nextMetadata: NormalizedCaptureMetadata): Promise<void> {
    if (!metadataInitialized) {
      const onDisk = await readMetadataFileIfExists(dir);
      if (onDisk !== null) {
        trackedMetadata = mergeConsistentMetadata(
          onDisk,
          trackedMetadata,
          ARCHIVE_METADATA_FILENAME,
        );
      }
      metadataInitialized = true;
    }

    const merged = mergeConsistentMetadata(trackedMetadata, nextMetadata, "archive append");
    const changed =
      merged.network !== trackedMetadata.network ||
      merged.contracts.market !== trackedMetadata.contracts.market ||
      merged.contracts.squad !== trackedMetadata.contracts.squad;
    trackedMetadata = merged;

    if (hasExplicitMetadata && changed) {
      await writeMetadataFileAtomic(dir, trackedMetadata);
    } else if (hasExplicitMetadata) {
      const onDisk = await readMetadataFileIfExists(dir);
      if (onDisk === null) {
        await writeMetadataFileAtomic(dir, trackedMetadata);
      }
    }
  }

  async function rotateIfNeeded(additionalBytes: number): Promise<void> {
    if (currentHandle && currentSize + additionalBytes <= maxBytes) {
      return;
    }

    if (currentHandle) {
      await currentHandle.sync();
      await currentHandle.close();
      currentHandle = null;
      currentFilePath = null;
    }

    await mkdir(dir, { recursive: true });

    // Enforce maxFiles by deleting older files if needed
    const existing = await listArchiveFiles(dir);
    // If we're creating a new file, we'll have existing.length + 1 files.
    // If existing.length + 1 > maxFiles, remove oldest so we stay within maxFiles.
    const toRemoveCount = Math.max(0, existing.length + 1 - maxFiles);
    for (let i = 0; i < toRemoveCount; i++) {
      const target = existing[i];
      if (!target) continue;
      try {
        await unlink(path.join(dir, target));
      } catch {
        // ignore
      }
    }

    fileIndex += 1;
    const filename = formatArchiveFilename(fileIndex, Date.now());
    currentFilePath = path.join(dir, filename);

    // Open with 'a+' flag (append and reading), 0o600 permissions
    currentHandle = await open(currentFilePath, "a+", FILE_MODE);
    try {
      await chmod(currentFilePath, FILE_MODE);
    } catch {
      // chmod might not be fully supported on some OS/filesystems, safe to ignore
    }

    const st = await currentHandle.stat();
    currentSize = st.size;
  }

  async function doAppend(events: readonly DecodedEvent[]): Promise<void> {
    if (closed) {
      throw new Error("Event archive is closed");
    }
    if (!events || events.length === 0) {
      if (hasExplicitMetadata && !metadataInitialized) {
        await ensureMetadataChecked(trackedMetadata);
      }
      return;
    }

    // Validate the entire batch before writing any bytes to disk.
    let candidateMeta = trackedMetadata;
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if (!ev) continue;
      const evMeta = extractEventMetadata(ev, `append event[${i}]`);
      candidateMeta = mergeConsistentMetadata(candidateMeta, evMeta, `append event[${i}]`);
    }
    await ensureMetadataChecked(candidateMeta);

    for (const event of events) {
      const line = JSON.stringify(event, scanJsonReplacer) + "\n";
      const buffer = Buffer.from(line, "utf8");
      const bytes = buffer.byteLength;

      // Rotate if adding this line exceeds maxBytes, or if no file opened yet
      if (!currentHandle || currentSize + bytes > maxBytes) {
        await rotateIfNeeded(bytes);
      }

      await currentHandle.write(buffer);
      await currentHandle.sync();
      currentSize += bytes;
    }
  }

  async function doClose(): Promise<void> {
    if (closed) return;
    closed = true;
    if (currentHandle) {
      await currentHandle.sync();
      await currentHandle.close();
      currentHandle = null;
    }
  }

  return {
    async append(events: readonly DecodedEvent[]): Promise<void> {
      const op = queue.then(() => doAppend(events));
      queue = op.catch(() => {});
      return op;
    },
    async close(): Promise<void> {
      const op = queue.then(() => doClose());
      queue = op.catch(() => {});
      return op;
    },
  };
}

async function listArchiveFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    return entries
      .filter((name) => name.startsWith("events-") && name.endsWith(".jsonl"))
      .sort();
  } catch {
    return [];
  }
}

interface ScannedArchiveData {
  metadata: NormalizedCaptureMetadata;
  events: DecodedEvent[];
}

async function scanAndValidateArchive(
  dir: string,
  options: ReadArchiveOptions = {},
): Promise<ScannedArchiveData> {
  let resolved = normalizeCaptureMetadata(options.expected, "expected archive metadata");
  let archiveDeclaredMeta: NormalizedCaptureMetadata = { network: null, contracts: {} };

  const sidecarMeta = await readMetadataFileIfExists(dir);
  if (sidecarMeta !== null) {
    archiveDeclaredMeta = mergeConsistentMetadata(
      archiveDeclaredMeta,
      sidecarMeta,
      ARCHIVE_METADATA_FILENAME,
    );
    resolved = mergeConsistentMetadata(resolved, sidecarMeta, ARCHIVE_METADATA_FILENAME);
  }

  const files = await listArchiveFiles(dir);
  const allEvents: DecodedEvent[] = [];

  for (const file of files) {
    const filePath = path.join(dir, file);
    const handle = await open(filePath, "r");
    try {
      const content = await handle.readFile({ encoding: "utf8" });
      const parsedFile = parseScanJsonlCapture(content, {
        expected: {
          network: resolved.network ?? undefined,
          contracts: resolved.contracts,
        },
      });
      archiveDeclaredMeta = mergeConsistentMetadata(archiveDeclaredMeta, parsedFile.metadata, file);
      resolved = mergeConsistentMetadata(resolved, parsedFile.metadata, file);
      for (const ev of parsedFile.events) {
        allEvents.push(ev);
      }
    } finally {
      await handle.close();
    }
  }

  if (options.requireNetwork && archiveDeclaredMeta.network === null) {
    throw new ArchiveMetadataError(
      "MISSING_METADATA",
      `Archive "${dir}" is missing required network metadata`,
    );
  }

  return { metadata: resolved, events: allEvents };
}

/**
 * Validate archive network and contract metadata across `archive-metadata.json`
 * and all rotated `.jsonl` segments before event iteration begins.
 */
export async function validateArchiveMetadata(
  dir: string,
  options: ReadArchiveOptions = {},
): Promise<NormalizedCaptureMetadata> {
  const scanned = await scanAndValidateArchive(dir, options);
  return scanned.metadata;
}

/**
 * Open an archive after eagerly validating all metadata across segments so
 * conflicting captures reject before iteration starts.
 */
export async function openVerifiedArchive(
  dir: string,
  options: ReadArchiveOptions = {},
): Promise<VerifiedArchive> {
  const scanned = await scanAndValidateArchive(dir, options);
  return {
    metadata: scanned.metadata,
    events: {
      async *[Symbol.asyncIterator](): AsyncGenerator<DecodedEvent, void, unknown> {
        for (const event of scanned.events) {
          yield event;
        }
      },
    },
  };
}

export async function* readArchive(
  dir: string,
  options: ReadArchiveOptions = {},
): AsyncGenerator<DecodedEvent, void, unknown> {
  const scanned = await scanAndValidateArchive(dir, options);
  for (const event of scanned.events) {
    yield event;
  }
}

/**
 * Aggregate multiple offline captures (archive directories or JSONL streams)
 * while validating metadata up front and keeping conflicting captures out of
 * the combined event list, histogram, and ledger bounds.
 */
export async function aggregateOfflineCaptures(
  captures: readonly OfflineCaptureSource[],
  options: OfflineAggregateOptions = {},
): Promise<OfflineAggregateResult> {
  const onConflict = options.onConflict ?? "exclude";
  let aggregateMeta = normalizeCaptureMetadata(options.expected, "expected aggregate metadata");
  const requireNetworkExplicit = options.requireNetwork === true;

  const collectedEvents: DecodedEvent[] = [];
  const acceptedCaptures: string[] = [];
  const rejectedCaptures: RejectedCaptureSummary[] = [];

  for (let idx = 0; idx < captures.length; idx++) {
    const capture = captures[idx];
    if (!capture) continue;
    const captureId =
      capture.id ?? ("dir" in capture ? capture.dir : `capture-${idx + 1}`);

    try {
      const explicitMeta = normalizeCaptureMetadata(
        capture.metadata,
        `capture "${captureId}" metadata`,
      );

      let captureMeta: NormalizedCaptureMetadata;
      let captureEvents: DecodedEvent[];

      if ("dir" in capture) {
        const scanned = await scanAndValidateArchive(capture.dir, {
          expected: {
            network: explicitMeta.network ?? undefined,
            contracts: explicitMeta.contracts,
          },
          requireNetwork: false,
        });
        captureMeta = mergeConsistentMetadata(explicitMeta, scanned.metadata, captureId);
        captureEvents = scanned.events;
      } else {
        const parsed = parseScanJsonlCapture(capture.jsonl, {
          expected: {
            network: explicitMeta.network ?? undefined,
            contracts: explicitMeta.contracts,
          },
          requireNetwork: false,
        });
        captureMeta = mergeConsistentMetadata(explicitMeta, parsed.metadata, captureId);
        captureEvents = parsed.events;
      }

      if (
        (requireNetworkExplicit || aggregateMeta.network !== null) &&
        captureMeta.network === null
      ) {
        throw new ArchiveMetadataError(
          "MISSING_METADATA",
          `Capture "${captureId}" is missing network metadata required to match "${aggregateMeta.network ?? "expected network"}"`,
        );
      }

      aggregateMeta = mergeConsistentMetadata(aggregateMeta, captureMeta, `capture "${captureId}"`);
      for (const ev of captureEvents) {
        collectedEvents.push(ev);
      }
      acceptedCaptures.push(captureId);
    } catch (err) {
      if (err instanceof ArchiveMetadataError) {
        if (onConflict === "throw") {
          throw err;
        }
        rejectedCaptures.push({
          id: captureId,
          code: err.code,
          message: err.message,
        });
        continue;
      }
      throw err;
    }
  }

  const deduped = sortEvents(dedupeEvents(collectedEvents));
  let minLedger = Infinity;
  let maxLedger = -Infinity;
  for (const ev of deduped) {
    if (typeof ev.ledger === "number" && Number.isFinite(ev.ledger)) {
      if (ev.ledger < minLedger) minLedger = ev.ledger;
      if (ev.ledger > maxLedger) maxLedger = ev.ledger;
    }
  }

  return {
    metadata: aggregateMeta,
    events: deduped,
    eventCount: deduped.length,
    histogram: eventHistogram(deduped),
    ledgerRange: minLedger <= maxLedger ? { minLedger, maxLedger } : null,
    acceptedCaptures,
    rejectedCaptures,
  };
}
