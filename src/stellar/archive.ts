import { open, mkdir, readdir, rm, stat, unlink, chmod } from "node:fs/promises";
import path from "node:path";
import { scanJsonReplacer } from "./events.js";
import type { DecodedEvent } from "./decode.js";
import {
  MAX_DIAGNOSTIC_LENGTH,
  MalformedArchiveRecordError,
  parseScanJsonl,
  parseSingleArchiveRecord,
  type MalformedRecordReasonCode,
  type ParseScanJsonlOptions,
  type ParsedScanJsonlResult,
} from "./scan-jsonl.js";

export {
  MAX_DIAGNOSTIC_LENGTH,
  MalformedArchiveRecordError,
  parseScanJsonl,
  type MalformedRecordReasonCode,
  type ParseScanJsonlOptions,
  type ParsedScanJsonlResult,
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

export interface ReadArchiveOptions {
  /**
   * Retain already read/committed events on `MalformedArchiveRecordError.retainedEvents`
   * when a later record fails validation. Defaults to `false`.
   */
  retainCommittedOutput?: boolean | undefined;
}

export interface ImportArchiveOptions extends EventArchiveOptions {
  sourceName?: string | undefined;
  /**
   * When `true`, events committed before a malformed line remain persisted in
   * `dir`. When `false` (default), newly written output from the failed import
   * is rolled back so no partial archive output remains.
   */
  retainCommittedOutput?: boolean | undefined;
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

export async function* readArchive(
  dir: string,
  options: ReadArchiveOptions = {},
): AsyncGenerator<DecodedEvent, void, unknown> {
  const retainCommitted = options.retainCommittedOutput === true;
  const retained: DecodedEvent[] = [];
  let committedCount = 0;

  const files = await listArchiveFiles(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    const handle = await open(filePath, "r");
    try {
      const content = await handle.readFile({ encoding: "utf8" });
      const lines = content.split("\n");
      for (let idx = 0; idx < lines.length; idx++) {
        const rawLine = (lines[idx] ?? "").replace(/\r$/, "");
        if (!rawLine.trim()) continue;

        const record = parseSingleArchiveRecord(rawLine, {
          file,
          line: idx + 1,
          committedCount,
          retainedEvents: retainCommitted ? [...retained] : [],
        });

        if (record.kind === "summary") {
          continue;
        }

        committedCount += 1;
        if (retainCommitted) {
          retained.push(record.event);
        }
        yield record.event;
      }
    } finally {
      await handle.close();
    }
  }
}

/**
 * Collect all events from an archive directory. When a malformed record is
 * encountered, throws {@link MalformedArchiveRecordError} with the exact 1-based
 * physical line number and retains prior events only when
 * `retainCommittedOutput: true` is explicitly passed.
 */
export async function readArchiveRecords(
  dir: string,
  options: ReadArchiveOptions = {},
): Promise<DecodedEvent[]> {
  const events: DecodedEvent[] = [];
  for await (const ev of readArchive(dir, options)) {
    events.push(ev);
  }
  return events;
}

async function directoryExists(dir: string): Promise<boolean> {
  try {
    const st = await stat(dir);
    return st.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Import JSONL records into an `EventArchive` directory.
 *
 * By default (`retainCommittedOutput: false`), if any record is malformed, all
 * output written during this import call is rolled back so no partial archive
 * files remain. When `retainCommittedOutput: true` is explicitly provided,
 * valid records committed before the malformed line are flushed and retained on
 * disk before throwing {@link MalformedArchiveRecordError}.
 */
export async function importScanJsonlToArchive(
  jsonl: string,
  options: ImportArchiveOptions,
): Promise<{ importedCount: number }> {
  const sourceName = options.sourceName ?? "<jsonl>";
  const retainCommitted = options.retainCommittedOutput === true;
  const existedBefore = await directoryExists(options.dir);
  const preExistingFiles = new Set(existedBefore ? await listArchiveFiles(options.dir) : []);

  const rawLines = jsonl.split("\n");
  const committedEvents: DecodedEvent[] = [];

  if (!retainCommitted) {
    // Validate every line before committing any output to `options.dir` so
    // pre-existing files (even under tight `maxFiles`) are untouched on failure.
    const parsed = parseScanJsonl(jsonl, {
      sourceName,
      retainCommittedOutput: false,
    });
    if (parsed.events.length === 0) {
      return { importedCount: 0 };
    }
    const archive = createEventArchive(options);
    try {
      await archive.append(parsed.events);
    } finally {
      await archive.close();
    }
    return { importedCount: parsed.events.length };
  }

  // Explicit retainCommittedOutput === true: commit line-by-line and retain
  // already committed records if a later line fails validation.
  const archive = createEventArchive(options);
  try {
    for (let idx = 0; idx < rawLines.length; idx++) {
      const rawLine = (rawLines[idx] ?? "").replace(/\r$/, "");
      if (!rawLine.trim()) continue;

      const record = parseSingleArchiveRecord(rawLine, {
        file: sourceName,
        line: idx + 1,
        committedCount: committedEvents.length,
        retainedEvents: [...committedEvents],
      });

      if (record.kind === "event") {
        await archive.append([record.event]);
        committedEvents.push(record.event);
      }
    }
  } catch (err) {
    await archive.close();
    // Defensive cleanup if 0 events were committed and we created an empty dir.
    if (committedEvents.length === 0 && !existedBefore) {
      const currentFiles = await listArchiveFiles(options.dir);
      const onlyNew = currentFiles.every((f) => !preExistingFiles.has(f));
      if (onlyNew && currentFiles.length === 0) {
        await rm(options.dir, { recursive: true, force: true });
      }
    }
    throw err;
  }

  await archive.close();
  return { importedCount: committedEvents.length };
}
