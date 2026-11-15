import { open, mkdir, readdir, rename, unlink, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { eventHistogram, scanJsonReplacer } from "./events.js";
import type { DecodedEvent } from "./decode.js";
import {
  CANONICAL_NEWLINE,
  computeArchiveRecordIdentity,
  decodeArchiveText,
  normalizeScanJsonl,
  parseScanJsonlEvents,
  serializeCanonicalRecord,
  splitNormalizedJsonlLines,
} from "./scan-jsonl.js";

export {
  CANONICAL_NEWLINE,
  computeArchiveRecordIdentity,
  decodeArchiveText,
  normalizeScanJsonl,
  parseScanJsonlEvents,
  serializeCanonicalRecord,
  splitNormalizedJsonlLines,
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

export interface CanonicalArchiveExportOptions {
  /** Include `{ type: "event" }` wrapper and trailing `{ type: "summary" }` line. */
  includeSummary?: boolean | undefined;
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
      const line = JSON.stringify(event, scanJsonReplacer) + CANONICAL_NEWLINE;
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
      const rawBytes = await handle.readFile();
      const lines = splitNormalizedJsonlLines(rawBytes);
      for (const line of lines) {
        const parsed = JSON.parse(line);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error(`Invalid archive JSON record in ${file}`);
        }
        const obj = parsed as Record<string, unknown>;
        if (obj.type === "summary") continue;
        const { type: _ignoredType, ...rest } = obj;
        yield rest as unknown as DecodedEvent;
      }
    } finally {
      await handle.close();
    }
  }
}

/**
 * Export all records in an archive directory in the documented canonical
 * platform-neutral format: UTF-8 without BOM, sorted JSON object keys, decimal
 * bigint strings, and single `\n` (LF, 0x0A) line terminators.
 */
export async function exportCanonicalArchive(
  dir: string,
  options: CanonicalArchiveExportOptions = {},
): Promise<string> {
  const events: DecodedEvent[] = [];
  for await (const event of readArchive(dir)) {
    events.push(event);
  }

  if (events.length === 0 && !options.includeSummary) {
    return "";
  }

  const lines: string[] = [];
  for (const event of events) {
    const record = options.includeSummary ? { type: "event", ...event } : event;
    lines.push(serializeCanonicalRecord(record));
  }

  if (options.includeSummary) {
    lines.push(
      serializeCanonicalRecord({
        type: "summary",
        eventCount: events.length,
        histogram: eventHistogram(events),
      }),
    );
  }

  return lines.join(CANONICAL_NEWLINE) + CANONICAL_NEWLINE;
}

/**
 * Normalize all `events-*.jsonl` segment files in `dir` to canonical UTF-8 LF
 * line endings in place (atomic temp-file + rename per segment) without
 * altering record identities.
 */
export async function normalizeArchiveDirectoryNewlines(
  dir: string,
): Promise<{ filesNormalized: number; recordCount: number }> {
  const files = await listArchiveFiles(dir);
  let filesNormalized = 0;
  let recordCount = 0;

  for (const file of files) {
    const filePath = path.join(dir, file);
    const handle = await open(filePath, "r");
    let rawBytes: Buffer;
    try {
      rawBytes = await handle.readFile();
    } finally {
      await handle.close();
    }

    const lines = splitNormalizedJsonlLines(rawBytes);
    recordCount += lines.length;
    const normalized = normalizeScanJsonl(rawBytes);
    const normalizedBytes = Buffer.from(normalized, "utf8");

    if (!rawBytes.equals(normalizedBytes)) {
      const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmpPath, normalizedBytes, { mode: FILE_MODE });
      try {
        await chmod(tmpPath, FILE_MODE);
      } catch {
        // ignore
      }
      await rename(tmpPath, filePath);
      filesNormalized += 1;
    }
  }

  return { filesNormalized, recordCount };
}
