import { createHash, type Hash } from "node:crypto";
import { open, mkdir, readdir, readFile, rename, rm, unlink, chmod, writeFile } from "node:fs/promises";
import path from "node:path";
import { scanJsonReplacer } from "./events.js";
import type { DecodedEvent } from "./decode.js";
import {
  DEFAULT_JSONL_CHUNK_BYTES,
  DEFAULT_MAX_JSONL_LINE_BYTES,
  JsonlLineTooLongError,
  parseJsonlStream,
} from "./scan-jsonl.js";

export {
  DEFAULT_JSONL_CHUNK_BYTES,
  DEFAULT_MAX_JSONL_LINE_BYTES,
  JsonlLineTooLongError,
};

export interface ArchiveMetadata {
  network?: string;
  contractId?: string;
}

export interface EventArchiveOptions {
  dir: string;
  maxBytes?: number;
  maxFiles?: number;
  /** Optional network and contract metadata written as a header record in new archive files. */
  metadata?: ArchiveMetadata;
}

export interface ReadArchiveOptions {
  /**
   * Maximum allowed byte length of a single JSONL record (excluding line ending).
   * Oversized records are rejected before UTF-8 decoding or `JSON.parse`.
   * Defaults to {@link DEFAULT_MAX_JSONL_LINE_BYTES} (64 KiB).
   */
  maxLineBytes?: number;
  /**
   * Fixed read buffer size in bytes for streaming each archive file.
   * Defaults to {@link DEFAULT_JSONL_CHUNK_BYTES} (64 KiB).
   */
  chunkBytes?: number;
}

export interface EventArchive {
  append(events: readonly DecodedEvent[]): Promise<void>;
  close(): Promise<void>;
}

export interface ReadArchiveOptions {
  /** Yield valid records before a malformed record instead of discarding them. Defaults to false. */
  retainCommitted?: boolean;
  /** Expected network metadata; rejects archives with contradictory network metadata. */
  expectedNetwork?: string;
  /** Expected contractId metadata; rejects archives with contradictory contractId metadata or events. */
  expectedContractId?: string;
}

export class ArchiveMetadataConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveMetadataConflictError";
  }
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

/**
 * Create an append-only event archive that writes the canonical JSONL export
 * format: UTF-8 encoded, one JSON record per line, delimited by LF (`\n`)
 * regardless of host operating system.
 */
export function createEventArchive(options: EventArchiveOptions): EventArchive {
  const { dir, metadata } = options;
  const maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_MAX_BYTES);
  const maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES);
  const hasMetadata = Boolean(metadata && (metadata.network !== undefined || metadata.contractId !== undefined));

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
      queue = queue.then(() => doAppend(events));
      return queue;
    },
    async close(): Promise<void> {
      queue = queue.then(() => doClose());
      return queue;
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
  await validateArchiveMetadata(dir, options);

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
          parsed = JSON.parse(trimmed);
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
/** File name of the hash-chained manifest stored alongside archive files. */
export const ARCHIVE_MANIFEST_FILENAME = "archive.manifest.json";

const MANIFEST_GENESIS_HASH = "0".repeat(64);

/**
 * Hash-chained manifest binding an archive's ordered records, network and
 * ledger bounds to a single digest. Each record hash commits to the previous
 * one, so missing, reordered or altered records fail verification.
 */
export interface ArchiveManifest {
  type: "archive-manifest";
  version: 1;
  network: string;
  ledgerMin: number | null;
  ledgerMax: number | null;
  recordCount: number;
  recordHashes: string[];
  chainHead: string;
}

export interface ArchiveManifestBounds {
  network: string;
  ledgerMin: number | null;
  ledgerMax: number | null;
}

export interface VerifyArchiveManifestResult {
  ok: boolean;
  recordCount: number;
  reason?: string;
}

function manifestChainStep(prevHash: string, recordLine: string): string {
  return createHash("sha256").update(`${prevHash}\n${recordLine}`, "utf8").digest("hex");
}

/** Read every non-blank record line of the archive in chronological order (LF-normalised). */
async function readArchiveRecordLines(dir: string): Promise<string[]> {
  const records: string[] = [];
  for (const file of await listArchiveFiles(dir)) {
    const content = await readFile(path.join(dir, file), "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) records.push(trimmed);
    }
  }
  return records;
}

function chainRecords(records: readonly string[]): { recordHashes: string[]; chainHead: string } {
  const recordHashes: string[] = [];
  let head = MANIFEST_GENESIS_HASH;
  for (const record of records) {
    head = manifestChainStep(head, record);
    recordHashes.push(head);
  }
  return { recordHashes, chainHead: head };
}

/**
 * Write a hash-chained manifest for the archive in `dir`, atomically
 * (`<manifest>.tmp` then rename). Returns the manifest written.
 */
export async function writeArchiveManifest(
  dir: string,
  bounds: ArchiveManifestBounds,
): Promise<ArchiveManifest> {
  const records = await readArchiveRecordLines(dir);
  const { recordHashes, chainHead } = chainRecords(records);
  const manifest: ArchiveManifest = {
    type: "archive-manifest",
    version: 1,
    network: bounds.network,
    ledgerMin: bounds.ledgerMin,
    ledgerMax: bounds.ledgerMax,
    recordCount: records.length,
    recordHashes,
    chainHead,
  };
  const target = path.join(dir, ARCHIVE_MANIFEST_FILENAME);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(manifest, null, 2) + "\n", { encoding: "utf8", mode: FILE_MODE });
  await rename(tmp, target);
  return manifest;
}

/**
 * Verify the archive in `dir` against its manifest. Fails closed when the
 * manifest is missing or unparseable, and when any record is missing,
 * reordered, altered, or outside the recorded ledger bounds.
 */
export async function verifyArchiveManifest(dir: string): Promise<VerifyArchiveManifestResult> {
  let manifest: ArchiveManifest;
  try {
    manifest = JSON.parse(
      await readFile(path.join(dir, ARCHIVE_MANIFEST_FILENAME), "utf8"),
    ) as ArchiveManifest;
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException)?.code === "ENOENT";
    return { ok: false, recordCount: 0, reason: missing ? "manifest missing" : "manifest parse error" };
  }
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    manifest.type !== "archive-manifest" ||
    !Array.isArray(manifest.recordHashes)
  ) {
    return { ok: false, recordCount: 0, reason: "manifest parse error" };
  }

  const records = await readArchiveRecordLines(dir);
  if (records.length !== manifest.recordCount || records.length !== manifest.recordHashes.length) {
    return { ok: false, recordCount: records.length, reason: "record count mismatch" };
  }
  let head = MANIFEST_GENESIS_HASH;
  for (let i = 0; i < records.length; i += 1) {
    head = manifestChainStep(head, records[i]!);
    if (head !== manifest.recordHashes[i]) {
      return { ok: false, recordCount: records.length, reason: `record ${i + 1} altered, reordered or missing` };
    }
  }
  if (head !== manifest.chainHead) {
    return { ok: false, recordCount: records.length, reason: "chain head mismatch" };
  }
  for (const record of records) {
    let ledger: unknown;
    try {
      ledger = (JSON.parse(record) as { ledger?: unknown }).ledger;
    } catch {
      return { ok: false, recordCount: records.length, reason: "malformed record" };
    }
    if (typeof ledger === "number") {
      if (
        (manifest.ledgerMin !== null && ledger < manifest.ledgerMin) ||
        (manifest.ledgerMax !== null && ledger > manifest.ledgerMax)
      ) {
        return { ok: false, recordCount: records.length, reason: "ledger bounds mismatch" };
      }
    }
  }
  return { ok: true, recordCount: records.length };
}
