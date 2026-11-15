import {
  open,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
  chmod,
} from "node:fs/promises";
import path from "node:path";
import { eventHistogram, scanJsonReplacer } from "./events.js";
import { dedupeEvents, sortEvents, type ContractSource, type DecodedEvent } from "./decode.js";
import {
  ArchiveCompactionError,
  compactScanJsonlByLedgerRange,
  computeLedgerSpan,
  extractContractsFromEvents,
  validateCompactionRange,
  type CompactedScanJsonlResult,
  type LedgerBounds,
} from "./scan-jsonl.js";

export {
  ArchiveCompactionError,
  compactScanJsonlByLedgerRange,
  validateCompactionRange,
  type CompactedScanJsonlResult,
  type LedgerBounds,
};

export const ARCHIVE_METADATA_FILENAME = "archive-metadata.json";

export interface EventArchiveOptions {
  dir: string;
  maxBytes?: number;
  maxFiles?: number;
}

export interface EventArchive {
  append(events: readonly DecodedEvent[]): Promise<void>;
  close(): Promise<void>;
}

export interface ArchiveCompactionMetadata {
  format: "mimir-archive-meta-v1";
  network?: string | null | undefined;
  requestedRange: LedgerBounds;
  retainedLedgerRange: { minLedger: number; maxLedger: number } | null;
  eventCount: number;
  droppedOutOfRangeCount: number;
  duplicateCount: number;
  segmentFiles: string[];
  contracts: Partial<Record<ContractSource, string>>;
  histogram: Record<string, number>;
}

export interface ArchiveCompactionOptions {
  dir: string;
  /** Optional separate destination directory; defaults to atomic in-place replacement of `dir`. */
  outputDir?: string | undefined;
  fromLedger: number;
  toLedger: number;
  maxBytes?: number | undefined;
  maxFiles?: number | undefined;
  /**
   * Optional verification hook executed against the staged archive directory
   * after built-in integrity checks and strictly before replacing the target.
   */
  verifyStaging?: ((stagingDir: string) => Promise<void> | void) | undefined;
}

export interface ArchiveCompactionResult {
  dir: string;
  metadata: ArchiveCompactionMetadata;
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MiB
const DEFAULT_MAX_FILES = 10;
const FILE_MODE = 0o600;

function formatArchiveFilename(index: number, timestamp: number): string {
  const ts = new Date(timestamp).toISOString().replace(/[:.]/g, "-");
  const idx = String(index).padStart(6, "0");
  return `events-${ts}-${idx}.jsonl`;
}

export function createEventArchive(options: EventArchiveOptions): EventArchive {
  const { dir } = options;
  const maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_MAX_BYTES);
  const maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES);

  let currentHandle: any = null;
  let currentFilePath: string | null = null;
  let currentSize = 0;
  let fileIndex = 0;
  let closed = false;

  let queue: Promise<void> = Promise.resolve();

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
    if (!events || events.length === 0) return;

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

export async function* readArchive(dir: string): AsyncGenerator<DecodedEvent, void, unknown> {
  const files = await listArchiveFiles(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    const handle = await open(filePath, "r");
    try {
      const content = await handle.readFile({ encoding: "utf8" });
      const lines = content.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parsed = JSON.parse(trimmed);
        yield parsed as DecodedEvent;
      }
    } finally {
      await handle.close();
    }
  }
}

async function readExistingSidecarNetwork(dir: string): Promise<string | null | undefined> {
  try {
    const raw = await readFile(path.join(dir, ARCHIVE_METADATA_FILENAME), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed?.network === "string" || parsed?.network === null) {
      return parsed.network;
    }
    return undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw new ArchiveCompactionError(
      "MALFORMED_SOURCE",
      `Failed to read existing ${ARCHIVE_METADATA_FILENAME}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function stableJsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Verify a compacted archive directory on disk against its rebuilt metadata
 * and expected retained events before committing any directory swap.
 */
export async function verifyCompactedArchive(
  dir: string,
  expectedEvents?: readonly DecodedEvent[],
): Promise<ArchiveCompactionMetadata> {
  let rawMeta: string;
  try {
    rawMeta = await readFile(path.join(dir, ARCHIVE_METADATA_FILENAME), "utf8");
  } catch (err) {
    throw new ArchiveCompactionError(
      "VERIFICATION_FAILED",
      `Missing ${ARCHIVE_METADATA_FILENAME} in compacted archive: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let parsedMeta: ArchiveCompactionMetadata;
  try {
    parsedMeta = JSON.parse(rawMeta) as ArchiveCompactionMetadata;
  } catch (err) {
    throw new ArchiveCompactionError(
      "VERIFICATION_FAILED",
      `Malformed ${ARCHIVE_METADATA_FILENAME}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!parsedMeta || parsedMeta.format !== "mimir-archive-meta-v1") {
    throw new ArchiveCompactionError(
      "VERIFICATION_FAILED",
      `Unexpected metadata format in ${ARCHIVE_METADATA_FILENAME}`,
    );
  }

  const bounds = validateCompactionRange(parsedMeta.requestedRange);
  const actualFiles = await listArchiveFiles(dir);
  if (!stableJsonEqual(actualFiles, parsedMeta.segmentFiles)) {
    throw new ArchiveCompactionError(
      "VERIFICATION_FAILED",
      `Compacted segment file list mismatch: expected ${JSON.stringify(parsedMeta.segmentFiles)}, found ${JSON.stringify(actualFiles)}`,
    );
  }

  const rereadEvents: DecodedEvent[] = [];
  try {
    for await (const ev of readArchive(dir)) {
      rereadEvents.push(ev);
    }
  } catch (err) {
    throw new ArchiveCompactionError(
      "VERIFICATION_FAILED",
      `Failed reading compacted archive segments: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (rereadEvents.length !== parsedMeta.eventCount) {
    throw new ArchiveCompactionError(
      "VERIFICATION_FAILED",
      `Compacted event count mismatch: metadata=${parsedMeta.eventCount}, segments=${rereadEvents.length}`,
    );
  }

  if (expectedEvents && rereadEvents.length !== expectedEvents.length) {
    throw new ArchiveCompactionError(
      "VERIFICATION_FAILED",
      `Compacted archive truncated retained events: expected ${expectedEvents.length}, found ${rereadEvents.length}`,
    );
  }

  for (let i = 0; i < rereadEvents.length; i++) {
    const ev = rereadEvents[i]!;
    if (
      typeof ev.ledger !== "number" ||
      !Number.isInteger(ev.ledger) ||
      ev.ledger < bounds.fromLedger ||
      ev.ledger > bounds.toLedger
    ) {
      throw new ArchiveCompactionError(
        "VERIFICATION_FAILED",
        `Compacted archive contains out-of-range ledger ${String(ev.ledger)} outside [${bounds.fromLedger}, ${bounds.toLedger}]`,
      );
    }
    if (expectedEvents) {
      const exp = expectedEvents[i]!;
      if (ev.eventId !== exp.eventId || ev.ledger !== exp.ledger || ev.txHash !== exp.txHash) {
        throw new ArchiveCompactionError(
          "VERIFICATION_FAILED",
          `Compacted event mismatch at index ${i}: expected ${exp.eventId}, found ${ev.eventId}`,
        );
      }
    }
  }

  const actualSpan = computeLedgerSpan(rereadEvents);
  if (!stableJsonEqual(actualSpan, parsedMeta.retainedLedgerRange)) {
    throw new ArchiveCompactionError(
      "VERIFICATION_FAILED",
      "Compacted retainedLedgerRange does not match stored events",
    );
  }

  const actualHistogram = eventHistogram(rereadEvents);
  if (!stableJsonEqual(actualHistogram, parsedMeta.histogram)) {
    throw new ArchiveCompactionError(
      "VERIFICATION_FAILED",
      "Compacted histogram does not match stored events",
    );
  }

  return parsedMeta;
}

async function atomicReplaceDirectory(stagingDir: string, targetDir: string): Promise<void> {
  const parentDir = path.dirname(targetDir);
  const baseName = path.basename(targetDir);
  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const backupDir = path.join(parentDir, `.${baseName}.compact-backup-${nonce}`);

  let targetExisted = false;
  try {
    const st = await stat(targetDir);
    targetExisted = st.isDirectory();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }

  if (!targetExisted) {
    await rename(stagingDir, targetDir);
    return;
  }

  await rename(targetDir, backupDir);
  try {
    await rename(stagingDir, targetDir);
  } catch (swapErr) {
    try {
      await rename(backupDir, targetDir);
    } catch {
      // Best-effort rollback if second rename failed.
    }
    throw swapErr;
  }

  await rm(backupDir, { recursive: true, force: true });
}

/**
 * Atomically compact an event archive directory to `[fromLedger, toLedger]`.
 *
 * Writes retained events and rebuilt `archive-metadata.json` to an isolated
 * sibling staging directory, verifies every segment and metadata invariant on
 * disk, and replaces the source directory only after verification succeeds.
 */
export async function compactArchiveByLedgerRange(
  options: ArchiveCompactionOptions,
): Promise<ArchiveCompactionResult> {
  const bounds = validateCompactionRange({
    fromLedger: options.fromLedger,
    toLedger: options.toLedger,
  });

  const sourceDir = path.resolve(options.dir);
  const targetDir = path.resolve(options.outputDir ?? options.dir);

  let sourceStat;
  try {
    sourceStat = await stat(sourceDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ArchiveCompactionError(
        "SOURCE_NOT_FOUND",
        `Archive directory does not exist: ${sourceDir}`,
      );
    }
    throw err;
  }
  if (!sourceStat.isDirectory()) {
    throw new ArchiveCompactionError(
      "SOURCE_NOT_FOUND",
      `Archive path is not a directory: ${sourceDir}`,
    );
  }

  const preservedNetwork = await readExistingSidecarNetwork(sourceDir);
  const sourceFiles = await listArchiveFiles(sourceDir);

  const inRange: DecodedEvent[] = [];
  let droppedOutOfRangeCount = 0;

  for (const file of sourceFiles) {
    const handle = await open(path.join(sourceDir, file), "r");
    try {
      const content = await handle.readFile({ encoding: "utf8" });
      const lines = content.split("\n");
      for (let idx = 0; idx < lines.length; idx++) {
        const trimmed = (lines[idx] ?? "").trim();
        if (!trimmed) continue;

        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          throw new ArchiveCompactionError(
            "MALFORMED_SOURCE",
            `Malformed JSON in ${file}:${idx + 1}`,
          );
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new ArchiveCompactionError(
            "MALFORMED_SOURCE",
            `Non-object record in ${file}:${idx + 1}`,
          );
        }
        const record = parsed as Record<string, unknown>;
        if (record.type === "summary" || record.type === "meta") {
          continue;
        }
        if (typeof record.ledger !== "number" || !Number.isInteger(record.ledger)) {
          throw new ArchiveCompactionError(
            "MALFORMED_SOURCE",
            `Record missing integer ledger in ${file}:${idx + 1}`,
          );
        }
        if (record.ledger < bounds.fromLedger || record.ledger > bounds.toLedger) {
          droppedOutOfRangeCount += 1;
          continue;
        }
        const { type: _ignoredType, ...rest } = record;
        inRange.push(rest as unknown as DecodedEvent);
      }
    } finally {
      await handle.close();
    }
  }

  const retained = sortEvents(dedupeEvents(inRange));
  const duplicateCount = inRange.length - retained.length;

  const targetParent = path.dirname(targetDir);
  await mkdir(targetParent, { recursive: true });
  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const stagingDir = path.join(
    targetParent,
    `.${path.basename(targetDir)}.compact-staging-${nonce}`,
  );
  await mkdir(stagingDir, { recursive: true });

  try {
    const effectiveMaxFiles =
      options.maxFiles ?? Math.max(DEFAULT_MAX_FILES, retained.length + 1);

    if (retained.length > 0) {
      const stagingArchive = createEventArchive({
        dir: stagingDir,
        ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
        maxFiles: effectiveMaxFiles,
      });
      await stagingArchive.append(retained);
      await stagingArchive.close();
    }

    const segmentFiles = await listArchiveFiles(stagingDir);
    const metadata: ArchiveCompactionMetadata = {
      format: "mimir-archive-meta-v1",
      ...(preservedNetwork !== undefined ? { network: preservedNetwork } : {}),
      requestedRange: bounds,
      retainedLedgerRange: computeLedgerSpan(retained),
      eventCount: retained.length,
      droppedOutOfRangeCount,
      duplicateCount,
      segmentFiles,
      contracts: extractContractsFromEvents(retained),
      histogram: eventHistogram(retained),
    };

    const metaPath = path.join(stagingDir, ARCHIVE_METADATA_FILENAME);
    await writeFile(metaPath, `${JSON.stringify(metadata, null, 2)}\n`, {
      encoding: "utf8",
      mode: FILE_MODE,
    });
    try {
      await chmod(metaPath, FILE_MODE);
    } catch {
      // ignore on filesystems without POSIX permissions
    }

    // Verify staged archive BEFORE replacing `targetDir`.
    const verifiedMeta = await verifyCompactedArchive(stagingDir, retained);
    if (options.verifyStaging) {
      await options.verifyStaging(stagingDir);
      // Re-verify in case verifyStaging inspected or mutated stagingDir!
      await verifyCompactedArchive(stagingDir, retained);
    }

    await atomicReplaceDirectory(stagingDir, targetDir);
    return {
      dir: targetDir,
      metadata: verifiedMeta,
    };
  } catch (err) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}
