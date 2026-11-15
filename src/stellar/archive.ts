import { open, mkdir, readdir, unlink, chmod } from "node:fs/promises";
import path from "node:path";
import { scanJsonReplacer } from "./events.js";
import type { DecodedEvent } from "./decode.js";
import {
  DEFAULT_MAX_JSONL_LINE_BYTES,
  DEFAULT_STREAM_CHUNK_BYTES,
  OversizedArchiveRecordError,
  normalizeChunkBytes,
  normalizeMaxLineBytes,
  streamBoundedJsonlLines,
  streamScanJsonlEvents,
  type BoundedLineStreamOptions,
} from "./scan-jsonl.js";

export {
  DEFAULT_MAX_JSONL_LINE_BYTES,
  DEFAULT_STREAM_CHUNK_BYTES,
  OversizedArchiveRecordError,
  streamBoundedJsonlLines,
  streamScanJsonlEvents,
  type BoundedLineStreamOptions,
};

export interface EventArchiveOptions {
  dir: string;
  maxBytes?: number;
  maxFiles?: number;
}

export interface EventArchive {
  append(events: readonly DecodedEvent[]): Promise<void>;
  close(): Promise<void>;
}

export interface ReadArchiveStreamOptions {
  /** Maximum UTF-8 byte length permitted for a single JSONL record (default: 256 KiB). */
  maxLineBytes?: number | undefined;
  /** File read chunk size in bytes (default: 64 KiB). */
  chunkBytes?: number | undefined;
}

export interface StreamArchiveImportOptions extends EventArchiveOptions, ReadArchiveStreamOptions {
  sourceName?: string | undefined;
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

async function* readFileInFixedChunks(
  filePath: string,
  chunkBytes: number,
): AsyncGenerator<Uint8Array, void, unknown> {
  const handle = await open(filePath, "r");
  const reusableBuffer = Buffer.allocUnsafe(chunkBytes);
  try {
    for (;;) {
      const { bytesRead } = await handle.read(reusableBuffer, 0, chunkBytes, null);
      if (bytesRead <= 0) {
        break;
      }
      yield reusableBuffer.subarray(0, bytesRead);
    }
  } finally {
    await handle.close();
  }
}

export async function* readArchive(
  dir: string,
  options: ReadArchiveStreamOptions = {},
): AsyncGenerator<DecodedEvent, void, unknown> {
  const maxLineBytes = normalizeMaxLineBytes(options.maxLineBytes);
  const chunkBytes = normalizeChunkBytes(options.chunkBytes);
  const files = await listArchiveFiles(dir);

  for (const file of files) {
    const filePath = path.join(dir, file);
    const chunks = readFileInFixedChunks(filePath, chunkBytes);
    for await (const event of streamScanJsonlEvents(chunks, {
      maxLineBytes,
      sourceName: file,
    })) {
      yield event;
    }
  }
}

/**
 * Stream a large JSONL chunk iterable into an `EventArchive` with a bounded
 * per-line buffer so memory stays independent of total archive size and
 * oversized lines fail before `JSON.parse`.
 */
export async function importArchiveFromStream(
  chunks: AsyncIterable<Uint8Array | string> | Iterable<Uint8Array | string>,
  options: StreamArchiveImportOptions,
): Promise<{ importedCount: number }> {
  const maxLineBytes = normalizeMaxLineBytes(options.maxLineBytes);
  const archive = createEventArchive(options);
  let importedCount = 0;

  try {
    for await (const event of streamScanJsonlEvents(chunks, {
      maxLineBytes,
      sourceName: options.sourceName ?? "<stream>",
    })) {
      await archive.append([event]);
      importedCount += 1;
    }
  } finally {
    await archive.close();
  }

  return { importedCount };
}

/**
 * Stream a large JSONL file from disk into an `EventArchive` in fixed-size
 * byte chunks without loading the whole source file into memory.
 */
export async function importArchiveFromFile(
  sourceFilePath: string,
  options: StreamArchiveImportOptions,
): Promise<{ importedCount: number }> {
  const chunkBytes = normalizeChunkBytes(options.chunkBytes);
  const chunks = readFileInFixedChunks(sourceFilePath, chunkBytes);
  return importArchiveFromStream(chunks, {
    ...options,
    sourceName: options.sourceName ?? path.basename(sourceFilePath),
  });
}
