import { open, mkdir, readdir, unlink, chmod } from "node:fs/promises";
import path from "node:path";
import { scanJsonReplacer } from "./events.js";
import type { DecodedEvent } from "./decode.js";
import {
  ProtectedStatePathError,
  assertSafeArchivePath,
  assertSafeSourceAndDestinationPaths,
  readScanJsonlFile,
  resolveCanonicalPathSync,
  writeScanJsonlFile,
  type ArchivePathRole,
  type LiveStateGuardOptions,
  type ProtectedPathKind,
} from "./scan-jsonl.js";

export {
  ProtectedStatePathError,
  assertSafeArchivePath,
  assertSafeSourceAndDestinationPaths,
  readScanJsonlFile,
  resolveCanonicalPathSync,
  writeScanJsonlFile,
  type ArchivePathRole,
  type LiveStateGuardOptions,
  type ProtectedPathKind,
};

export interface EventArchiveOptions extends LiveStateGuardOptions {
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
  assertSafeArchivePath(options.dir, "destination", options);

  const dir = path.resolve(options.cwd ?? process.cwd(), options.dir);
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

    assertSafeArchivePath(dir, "destination", options);
    await mkdir(dir, { recursive: true });

    // Enforce maxFiles by deleting older files if needed
    const existing = await listArchiveFiles(dir);
    // If we're creating a new file, we'll have existing.length + 1 files.
    // If existing.length + 1 > maxFiles, remove oldest so we stay within maxFiles.
    const toRemoveCount = Math.max(0, existing.length + 1 - maxFiles);
    for (let i = 0; i < toRemoveCount; i++) {
      const target = existing[i];
      if (!target) continue;
      const candidateRemove = path.join(dir, target);
      assertSafeArchivePath(candidateRemove, "destination", options);
      try {
        await unlink(candidateRemove);
      } catch {
        // ignore
      }
    }

    fileIndex += 1;
    const filename = formatArchiveFilename(fileIndex, Date.now());
    const nextFilePath = path.join(dir, filename);
    assertSafeArchivePath(nextFilePath, "destination", options);
    currentFilePath = nextFilePath;

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

async function* readArchiveValidated(
  dir: string,
  options: LiveStateGuardOptions,
): AsyncGenerator<DecodedEvent, void, unknown> {
  const absDir = path.resolve(options.cwd ?? process.cwd(), dir);
  const files = await listArchiveFiles(absDir);
  for (const file of files) {
    const filePath = path.join(absDir, file);
    assertSafeArchivePath(filePath, "source", options);
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

export function readArchive(
  dir: string,
  options: LiveStateGuardOptions = {},
): AsyncGenerator<DecodedEvent, void, unknown> {
  assertSafeArchivePath(dir, "source", options);
  return readArchiveValidated(dir, options);
}

/**
 * Export an event archive directory to a standalone JSONL capture file after
 * checking both resolved source and destination paths up front.
 */
export async function exportArchiveToJsonlFile(
  sourceDir: string,
  destinationFile: string,
  options: LiveStateGuardOptions = {},
): Promise<{ exportedCount: number }> {
  assertSafeSourceAndDestinationPaths(
    { sourcePath: sourceDir, destinationPath: destinationFile },
    options,
  );
  const events: DecodedEvent[] = [];
  for await (const ev of readArchive(sourceDir, options)) {
    events.push(ev);
  }
  await writeScanJsonlFile(destinationFile, events, options);
  return { exportedCount: events.length };
}

/**
 * Import a standalone JSONL capture file into an event archive directory after
 * checking both resolved source and destination paths before opening either.
 */
export async function importJsonlFileToArchive(
  sourceFile: string,
  destinationOptions: EventArchiveOptions,
): Promise<{ importedCount: number }> {
  assertSafeSourceAndDestinationPaths(
    { sourcePath: sourceFile, destinationPath: destinationOptions.dir },
    destinationOptions,
  );
  const events = await readScanJsonlFile(sourceFile, destinationOptions);
  const archive = createEventArchive(destinationOptions);
  try {
    await archive.append(events);
  } finally {
    await archive.close();
  }
  return { importedCount: events.length };
}
