import { open, mkdir, readdir, unlink, chmod, readFile, writeFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { scanJsonReplacer } from "./events.js";
import type { DecodedEvent } from "./decode.js";
import { validateLedgerRange, type LedgerRange } from "./ledger-range.js";
import { compareLedgerCoverage } from "./scan-jsonl.js";
import type {
  ArchiveCoverageInput,
  ArchiveCoverageOptions,
  ArchiveCoverageReport,
} from "./scan-jsonl.js";

export { validateLedgerRange, type LedgerRange };
export {
  compareLedgerCoverage,
  compareScanJsonlCoverage,
  formatArchiveCoverageReport,
  renderArchiveCoverageReport,
  formatCoverageReport,
  renderCoverageReport,
  type ArchiveCoverageInput,
  type ArchiveCoverageOptions,
  type ArchiveCoverageReport,
  type ArchiveCoverageTotals,
  type CoverageCaptureSummary,
  type CoverageCountMismatch,
  type CoverageFinding,
  type CoverageSpan,
} from "./scan-jsonl.js";

export interface EventArchiveOptions {
  dir: string;
  maxBytes?: number;
  maxFiles?: number;
  schemaVersion?: number;
}

export interface EventArchive {
  append(events: readonly DecodedEvent[]): Promise<void>;
  close(): Promise<void>;
}

export interface ReadArchiveOptions {
  /** Yield valid records before a malformed record instead of discarding them. Defaults to false. */
  retainCommitted?: boolean;
  acceptedVersions?: readonly number[];
  requireExplicitVersion?: boolean;
}

export class MalformedArchiveRecordError extends Error {
  readonly fileName: string;
  readonly lineNumber: number;

  constructor(fileName: string, lineNumber: number) {
    const safeFileName = path
      .basename(fileName)
      .replace(/[\x00-\x1f\x7f]/g, " ")
      .slice(0, 128);
    const displayedFileName = safeFileName || "<unknown>";
    super(`Malformed archive record at ${displayedFileName}:${lineNumber}`);
    this.name = "MalformedArchiveRecordError";
    this.fileName = displayedFileName;
    this.lineNumber = lineNumber;
  }
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MiB
const DEFAULT_MAX_FILES = 10;
const FILE_MODE = 0o600;

function formatArchiveFilename(index: number, timestamp: number): string {
  const ts = new Date(timestamp).toISOString().replace(/[:.]/g, "-");
  const idx = String(index).padStart(6, "0");
  return `events-${ts}-${idx}.jsonl`;
}

export interface InspectedArchiveSchema {
  schemaVersion: number;
  explicitVersionFound: boolean;
}

async function readArchiveSchema(
  dir: string,
  acceptedVersions?: readonly number[],
): Promise<InspectedArchiveSchema> {
  const filePath = path.join(dir, ARCHIVE_SCHEMA_FILENAME);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        schemaVersion: negotiateArchiveSchemaVersion({
          format: ARCHIVE_SCHEMA_FORMAT,
          mode: "read",
          requestedVersion: DEFAULT_ARCHIVE_SCHEMA_VERSION,
          acceptedVersions,
        }),
        explicitVersionFound: false,
      };
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new UnsupportedArchiveSchemaError({
      code: "INVALID_SCHEMA_VERSION",
      message: `Malformed JSON in ${ARCHIVE_SCHEMA_FILENAME}`,
    });
  }

  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    typeof (parsed as Record<string, unknown>).format !== "string"
  ) {
    throw new UnsupportedArchiveSchemaError({
      code: "INCOMPATIBLE_SCHEMA_FORMAT",
      message: `${ARCHIVE_SCHEMA_FILENAME} must contain a format and schemaVersion`,
    });
  }

  const metadata = parsed as Record<string, unknown>;
  if (metadata.schemaVersion === undefined) {
    throw new UnsupportedArchiveSchemaError({
      code: "INVALID_SCHEMA_VERSION",
      message: `${ARCHIVE_SCHEMA_FILENAME} must declare a schemaVersion`,
    });
  }
  const schemaVersion = negotiateArchiveSchemaVersion({
    format: metadata.format as string,
    mode: "read",
    requestedVersion: metadata.schemaVersion,
    acceptedVersions,
  });
  if (metadata.format !== ARCHIVE_SCHEMA_FORMAT) {
    throw new UnsupportedArchiveSchemaError({
      code: "INCOMPATIBLE_SCHEMA_FORMAT",
      foundVersion: metadata.format,
      message: `Incompatible archive schema format "${metadata.format}"`,
    });
  }
  return { schemaVersion, explicitVersionFound: true };
}

async function writeArchiveSchema(dir: string, schemaVersion: number): Promise<void> {
  await mkdir(dir, { recursive: true });
  const targetPath = path.join(dir, ARCHIVE_SCHEMA_FILENAME);
  const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  const schema: ArchiveSchemaFile = {
    format: ARCHIVE_SCHEMA_FORMAT,
    schemaVersion,
  };
  await writeFile(temporaryPath, `${JSON.stringify(schema, null, 2)}\n`, {
    encoding: "utf8",
    mode: FILE_MODE,
  });
  try {
    await chmod(temporaryPath, FILE_MODE);
  } catch {
    // chmod might not be fully supported on some OS/filesystems.
  }
  try {
    await rename(temporaryPath, targetPath);
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
    }
    throw error;
  }
}

/**
 * Create an append-only event archive that writes the canonical JSONL export
 * format: UTF-8 encoded, one JSON record per line, delimited by LF (`\n`)
 * regardless of host operating system.
 */
export function createEventArchive(options: EventArchiveOptions): EventArchive {
  const { dir, metadata } = options;
  const maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_MAX_BYTES);
  const maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES);
  const writerVersion = negotiateArchiveSchemaVersion({
    format: ARCHIVE_SCHEMA_FORMAT,
    mode: "write",
    requestedVersion: options.schemaVersion,
  });

  let currentHandle: any = null;
  let currentFilePath: string | null = null;
  let currentSize = 0;
  let fileIndex = 0;
  let closed = false;
  let schemaVerified = false;

  let queue: Promise<void> = Promise.resolve();

  async function ensureWriterSchema(): Promise<void> {
    if (schemaVerified) return;
    const existing = await readArchiveSchema(dir);
    if (existing.explicitVersionFound && existing.schemaVersion !== writerVersion) {
      throw new UnsupportedArchiveSchemaError({
        code: "UNSUPPORTED_SCHEMA_VERSION",
        foundVersion: existing.schemaVersion,
        supportedVersions: SUPPORTED_ARCHIVE_WRITER_VERSIONS,
        message: `Archive directory schema v${existing.schemaVersion} conflicts with writer v${writerVersion}`,
      });
    }
    if (!existing.explicitVersionFound) {
      await writeArchiveSchema(dir, writerVersion);
    }
    schemaVerified = true;
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

    if (hasMetadata && currentSize === 0) {
      const header = JSON.stringify({ type: "metadata", ...metadata }) + "\n";
      const headerBuf = Buffer.from(header, "utf8");
      await currentHandle.write(headerBuf);
      await currentHandle.sync();
      currentSize += headerBuf.byteLength;
    }
  }

  async function doAppend(events: readonly DecodedEvent[]): Promise<void> {
    if (closed) {
      throw new Error("Event archive is closed");
    }
    await ensureWriterSchema();
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
      const operation = queue.then(() => doAppend(events));
      queue = operation.catch(() => {});
      return operation;
    },
    async close(): Promise<void> {
      const operation = queue.then(() => doClose());
      queue = operation.catch(() => {});
      return operation;
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

export interface CompactArchiveOptions {
  /** Maximum bytes per output file. Defaults to the archive's 10 MiB rotation size. */
  maxBytes?: number;
}

export interface CompactArchiveResult {
  /** Events retained because their ledger fell inside the requested range. */
  retained: number;
  /** Events dropped because their ledger fell outside the requested range. */
  dropped: number;
  /** Number of JSONL files in the compacted archive. */
  files: number;
  /** SHA-256 of the compacted archive's canonical JSONL records, for evidence. */
  digest: string;
}

let compactSequence = 0;

/** Hash one record exactly as `createEventArchive` serializes it. */
function hashArchiveRecord(hash: Hash, event: DecodedEvent): void {
  hash.update(JSON.stringify(event, scanJsonReplacer) + "\n");
}

/**
 * Read a compacted archive back and prove that it contains exactly the
 * retained records: same count, same content digest, every ledger in range.
 */
async function verifyCompactedArchive(
  dir: string,
  range: LedgerRange,
  expectedCount: number,
  expectedDigest: string,
): Promise<string> {
  const { firstLedger, lastLedger } = range;
  const hash = createHash("sha256");
  let count = 0;

  for await (const event of readArchive(dir)) {
    if (
      !Number.isSafeInteger(event.ledger) ||
      event.ledger < firstLedger ||
      event.ledger > lastLedger
    ) {
      throw new Error(
        `Compaction verification failed: ledger ${event.ledger} is outside ` +
          `[${firstLedger}, ${lastLedger}]`,
      );
    }
    hashArchiveRecord(hash, event);
    count += 1;
  }

  if (count !== expectedCount) {
    throw new Error(
      `Compaction verification failed: wrote ${expectedCount} records but read back ${count}`,
    );
  }

  const digest = hash.digest("hex");
  if (digest !== expectedDigest) {
    throw new Error(
      "Compaction verification failed: compacted records do not match the retained records",
    );
  }
  return digest;
}

/**
 * Move the verified compacted directory into place, restoring the source if
 * the swap cannot complete. The source is only touched after verification.
 */
async function swapArchiveDirectory(
  tmpDir: string,
  dir: string,
  oldDir: string,
  hasContent: boolean,
): Promise<void> {
  await rename(dir, oldDir);
  try {
    if (hasContent) {
      await rename(tmpDir, dir);
    } else {
      // An empty range leaves a valid, empty archive directory behind.
      await mkdir(dir, { recursive: true });
    }
  } catch (err) {
    try {
      await rename(oldDir, dir);
    } catch {
      // best-effort restore; the original error is the actionable one
    }
    throw err;
  }

  try {
    await rm(oldDir, { recursive: true, force: true });
  } catch {
    // The compacted archive is already in place; a leftover backup is harmless.
  }
}

/**
 * Atomically compact an archive directory to an inclusive ledger range.
 *
 * Steps:
 * 1. Stream every record from `dir` and write in-range records to a temporary
 *    sibling directory (outside `dir`, so the source is untouched).
 * 2. Read the temporary directory back and verify the record count, a SHA-256
 *    digest of the canonical JSONL records, and that every retained ledger is
 *    in range.
 * 3. Only after verification, swap the compacted directory into place
 *    (rename source aside, rename compacted copy in, remove the backup).
 *
 * A malformed source record, an I/O error, or a failed verification aborts the
 * compaction with `dir` unchanged. Existing archive behavior is unaffected;
 * this is an explicit maintenance operation over a settled capture.
 */
export async function compactArchive(
  dir: string,
  range: LedgerRange,
  options: CompactArchiveOptions = {},
): Promise<CompactArchiveResult> {
  validateLedgerRange(range);

  try {
    await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Archive directory does not exist: ${dir}`);
    }
    throw err;
  }

  const { firstLedger, lastLedger } = range;
  const suffix = `${process.pid}-${Date.now()}-${(compactSequence += 1)}`;
  const tmpDir = `${dir}.compact-${suffix}`;
  const oldDir = `${dir}.old-${suffix}`;

  let retained = 0;
  let dropped = 0;

  try {
    // --- Filter into a temporary sibling directory ---
    const tmpArchive = createEventArchive({
      dir: tmpDir,
      maxBytes: options.maxBytes,
      maxFiles: Number.MAX_SAFE_INTEGER,
    });
    const writeHash = createHash("sha256");

    try {
      for await (const event of readArchive(dir, { retainCommitted: true })) {
        if (event.ledger >= firstLedger && event.ledger <= lastLedger) {
          await tmpArchive.append([event]);
          hashArchiveRecord(writeHash, event);
          retained += 1;
        } else {
          dropped += 1;
        }
      }
    } finally {
      await tmpArchive.close();
    }

    // --- Verify before touching the source ---
    const digest = await verifyCompactedArchive(
      tmpDir,
      range,
      retained,
      writeHash.digest("hex"),
    );
    const files = (await listArchiveFiles(tmpDir)).length;

    // --- Swap the verified copy into place ---
    await swapArchiveDirectory(tmpDir, dir, oldDir, files > 0);

    return { retained, dropped, files, digest };
  } catch (err) {
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failure; the original error is the actionable one
    }
    throw err;
  }
}

/**
 * Read decoded events from an archive directory in chronological file order.
 * Accepts both LF (`\n`) and CRLF (`\r\n`) line endings without altering record
 * identities, skipping blank lines.
 */
export async function* readArchive(
  dir: string,
  options: ReadArchiveOptions = {},
): AsyncGenerator<DecodedEvent, void, unknown> {
  const archiveSchema = await readArchiveSchema(dir, options.acceptedVersions);
  if (options.requireExplicitVersion && !archiveSchema.explicitVersionFound) {
    throw new UnsupportedArchiveSchemaError({
      code: "MISSING_SCHEMA_VERSION",
      message: `Archive "${dir}" does not declare an explicit schema version`,
    });
  }

  const files = await listArchiveFiles(dir);
  const stagedEvents: DecodedEvent[] = [];
  const retainCommitted = options.retainCommitted === true;

  for (const file of files) {
    const filePath = path.join(dir, file);
    const handle = await open(filePath, "r");
    try {
      const content = await handle.readFile({ encoding: "utf8" });
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!;
        const trimmed = line.trim();
        if (!trimmed) continue;
        let parsed: unknown;
        try {
          const value: unknown = JSON.parse(trimmed);
          if (
            value !== null &&
            typeof value === "object" &&
            "type" in value &&
            value.type === "schema"
          ) {
            throw new Error("schema headers belong in archive-schema.json");
          }
          parsed = value as DecodedEvent;
        } catch {
          throw new MalformedArchiveRecordError(file, index + 1);
        }

        if (isMetadataRecord(parsed)) {
          continue;
        }

        const event = parsed as DecodedEvent;
        if (retainCommitted) {
          yield event;
        } else {
          stagedEvents.push(event);
        }
      }
    } finally {
      await handle.close();
    }
  }

  for (const event of stagedEvents) {
    yield event;
  }
}

export async function inspectArchiveSchema(
  dir: string,
  options: Pick<ReadArchiveOptions, "acceptedVersions"> = {},
): Promise<InspectedArchiveSchema> {
  return readArchiveSchema(dir, options.acceptedVersions);
}

function looksLikeArchivePath(input: ArchiveCoverageInput): input is string {
  if (typeof input !== "string") return false;
  const trimmed = input.trim();
  return trimmed.length > 0 && !trimmed.startsWith("{") && !trimmed.startsWith("[");
}

async function readCoverageCapture(dir: string): Promise<DecodedEvent[]> {
  const events: DecodedEvent[] = [];
  for await (const event of readArchive(dir)) events.push(event);
  return events;
}

export async function compareArchiveDirCoverage(
  firstDir: string,
  secondDir: string,
  options: ArchiveCoverageOptions | LedgerRange = {},
): Promise<ArchiveCoverageReport> {
  const [first, second] = await Promise.all([
    readCoverageCapture(firstDir),
    readCoverageCapture(secondDir),
  ]);
  return compareLedgerCoverage(first, second, options);
}

export function compareArchiveCoverage(
  first: ArchiveCoverageInput,
  second: ArchiveCoverageInput,
  options: ArchiveCoverageOptions | LedgerRange = {},
): ArchiveCoverageReport | Promise<ArchiveCoverageReport> {
  if (looksLikeArchivePath(first) || looksLikeArchivePath(second)) {
    if (typeof first !== "string" || typeof second !== "string") {
      throw new TypeError("Both archive paths must be strings");
    }
    return compareArchiveDirCoverage(first, second, options);
  }
  return compareLedgerCoverage(first, second, options);
}
