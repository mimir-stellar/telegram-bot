import {
  open,
  mkdir,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
  chmod,
} from "node:fs/promises";
import path from "node:path";
import { scanJsonReplacer } from "./events.js";
import type { DecodedEvent } from "./decode.js";
import {
  ARCHIVE_HASH_ALGORITHM,
  ARCHIVE_MANIFEST_FORMAT,
  ArchiveManifestVerificationError,
  advanceChainHash,
  buildHashChainedManifestFromSegments,
  computeGenesisHash,
  computeRecordDigest,
  computeRootDigest,
  exportVerifiableScanJsonl,
  verifyScanJsonlManifest,
  verifySegmentsAgainstManifest,
  type ArchiveManifest,
  type ArchiveManifestContext,
  type ArchiveManifestSegmentEntry,
  type ManifestLedgerBounds,
  type ManifestVerificationErrorCode,
  type VerifyManifestExpectations,
} from "./scan-jsonl.js";

export {
  ARCHIVE_HASH_ALGORITHM,
  ARCHIVE_MANIFEST_FORMAT,
  ArchiveManifestVerificationError,
  advanceChainHash,
  buildHashChainedManifestFromSegments,
  computeGenesisHash,
  computeRecordDigest,
  computeRootDigest,
  exportVerifiableScanJsonl,
  verifyScanJsonlManifest,
  verifySegmentsAgainstManifest,
  type ArchiveManifest,
  type ArchiveManifestContext,
  type ArchiveManifestSegmentEntry,
  type ManifestLedgerBounds,
  type ManifestVerificationErrorCode,
  type VerifyManifestExpectations,
};

export const ARCHIVE_MANIFEST_FILENAME = "archive-manifest.json" as const;

export interface EventArchiveOptions {
  dir: string;
  maxBytes?: number;
  maxFiles?: number;
}

export interface EventArchive {
  append(events: readonly DecodedEvent[]): Promise<void>;
  close(): Promise<void>;
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

async function readArchiveSegments(
  dir: string,
): Promise<Array<{ file: string; events: DecodedEvent[] }>> {
  const files = await listArchiveFiles(dir);
  const segments: Array<{ file: string; events: DecodedEvent[] }> = [];

  for (const file of files) {
    const filePath = path.join(dir, file);
    const handle = await open(filePath, "r");
    try {
      const content = await handle.readFile({ encoding: "utf8" });
      const events: DecodedEvent[] = [];
      const lines = content.split(/\r?\n/);
      for (let idx = 0; idx < lines.length; idx++) {
        const trimmed = (lines[idx] ?? "").trim();
        if (!trimmed) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          throw new ArchiveManifestVerificationError(
            "INVALID_MANIFEST",
            `Malformed JSON in archive segment ${file}:${idx + 1}`,
          );
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new ArchiveManifestVerificationError(
            "INVALID_MANIFEST",
            `Non-object JSON record in archive segment ${file}:${idx + 1}`,
          );
        }
        const obj = parsed as Record<string, unknown>;
        if (obj.type === "summary") continue;
        const { type: _ignoredType, ...rest } = obj;
        events.push(rest as unknown as DecodedEvent);
      }
      segments.push({ file, events });
    } finally {
      await handle.close();
    }
  }

  return segments;
}

/**
 * Build and atomically write `archive-manifest.json` for an existing archive
 * directory, binding ordered segment records, network, and ledger bounds into a
 * SHA-256 hash chain.
 */
export async function writeArchiveManifest(
  dir: string,
  context: ArchiveManifestContext,
): Promise<ArchiveManifest> {
  await mkdir(dir, { recursive: true });
  const segments = await readArchiveSegments(dir);
  const manifest = buildHashChainedManifestFromSegments(segments, context);

  const manifestPath = path.join(dir, ARCHIVE_MANIFEST_FILENAME);
  const tmpPath = `${manifestPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmpPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      mode: FILE_MODE,
    });
    try {
      await chmod(tmpPath, FILE_MODE);
    } catch {
      // ignore on filesystems without POSIX permissions
    }
    await rename(tmpPath, manifestPath);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }

  return manifest;
}

/**
 * Export events into an archive directory and seal it with a hash-chained
 * `archive-manifest.json`.
 */
export async function exportEventArchiveWithManifest(
  events: readonly DecodedEvent[],
  options: EventArchiveOptions & { context: ArchiveManifestContext },
): Promise<ArchiveManifest> {
  const effectiveMaxFiles =
    options.maxFiles ?? Math.max(DEFAULT_MAX_FILES, events.length + 1);
  const archive = createEventArchive({
    dir: options.dir,
    ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
    maxFiles: effectiveMaxFiles,
  });
  try {
    if (events.length > 0) {
      await archive.append(events);
    }
  } finally {
    await archive.close();
  }
  return writeArchiveManifest(options.dir, options.context);
}

/**
 * Verify an archive directory against its `archive-manifest.json`, rejecting
 * missing, extra, reordered, or altered records and network/ledger bound
 * tampering.
 */
export async function verifyArchiveManifest(
  dir: string,
  expectations: VerifyManifestExpectations = {},
): Promise<{ manifest: ArchiveManifest; events: DecodedEvent[] }> {
  const manifestPath = path.join(dir, ARCHIVE_MANIFEST_FILENAME);
  let rawManifest: string;
  try {
    rawManifest = await readFile(manifestPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ArchiveManifestVerificationError(
        "MISSING_MANIFEST",
        `Archive "${dir}" is missing ${ARCHIVE_MANIFEST_FILENAME}`,
      );
    }
    throw err;
  }

  let parsedManifest: ArchiveManifest;
  try {
    parsedManifest = JSON.parse(rawManifest) as ArchiveManifest;
  } catch {
    throw new ArchiveManifestVerificationError(
      "INVALID_MANIFEST",
      `Malformed JSON in ${ARCHIVE_MANIFEST_FILENAME}`,
    );
  }

  const segments = await readArchiveSegments(dir);
  const events = verifySegmentsAgainstManifest(segments, parsedManifest, expectations);
  return { manifest: parsedManifest, events };
}

/**
 * Iterate events from an archive directory only after its hash-chained manifest
 * verifies completely.
 */
export async function* readVerifiedArchive(
  dir: string,
  expectations: VerifyManifestExpectations = {},
): AsyncGenerator<DecodedEvent, void, unknown> {
  const { events } = await verifyArchiveManifest(dir, expectations);
  for (const ev of events) {
    yield ev;
  }
}
