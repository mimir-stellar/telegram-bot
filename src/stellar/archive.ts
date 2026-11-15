import { open, mkdir, readdir, unlink, chmod } from "node:fs/promises";
import path from "node:path";
import { eventKey } from "../dedup.js";
import { scanJsonReplacer } from "./events.js";
import type { DecodedEvent } from "./decode.js";

export interface ArchiveCompactionOptions {
  minLedger?: number;
  maxLedger?: number;
  maxBytes?: number;
  maxFiles?: number;
}

export interface ArchiveCompactionStats {
  beforeCount: number;
  afterCount: number;
  duplicatesRemoved: number;
  droppedByRange: number;
}

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

/**
 * Deterministically compact a sequence of archived events by deduplicating
 * canonical event identities and optionally filtering to `[minLedger, maxLedger]`.
 */
export function compactArchiveEvents(
  events: readonly DecodedEvent[],
  options: Pick<ArchiveCompactionOptions, "minLedger" | "maxLedger"> = {},
): { events: DecodedEvent[]; stats: ArchiveCompactionStats } {
  const seenKeys = new Set<string>();
  const retained: DecodedEvent[] = [];
  let duplicatesRemoved = 0;
  let droppedByRange = 0;

  for (const ev of events) {
    if (!ev || typeof ev !== "object") continue;
    const ledger = typeof ev.ledger === "number" && Number.isFinite(ev.ledger) ? ev.ledger : null;
    if (options.minLedger !== undefined && ledger !== null && ledger < options.minLedger) {
      droppedByRange += 1;
      continue;
    }
    if (options.maxLedger !== undefined && ledger !== null && ledger > options.maxLedger) {
      droppedByRange += 1;
      continue;
    }

    const key = eventKey(ev);
    if (key !== null) {
      if (seenKeys.has(key)) {
        duplicatesRemoved += 1;
        continue;
      }
      seenKeys.add(key);
    }

    retained.push(ev);
  }

  retained.sort((a, b) => {
    if (a.ledger !== b.ledger) return a.ledger - b.ledger;
    const aTx = a.transactionIndex ?? 0;
    const bTx = b.transactionIndex ?? 0;
    if (aTx !== bTx) return aTx - bTx;
    const aOp = a.operationIndex ?? 0;
    const bOp = b.operationIndex ?? 0;
    if (aOp !== bOp) return aOp - bOp;
    return String(a.eventId ?? "").localeCompare(String(b.eventId ?? ""));
  });

  return {
    events: retained,
    stats: {
      beforeCount: events.length,
      afterCount: retained.length,
      duplicatesRemoved,
      droppedByRange,
    },
  };
}

/**
 * Compact an on-disk event archive directory into `targetDir`, removing duplicate
 * lines and applying optional ledger retention bounds.
 */
export async function compactArchive(
  sourceDir: string,
  targetDir: string,
  options: ArchiveCompactionOptions = {},
): Promise<ArchiveCompactionStats> {
  const rawEvents: DecodedEvent[] = [];
  for await (const ev of readArchive(sourceDir)) {
    rawEvents.push(ev);
  }

  const { events, stats } = compactArchiveEvents(rawEvents, options);
  const writer = createEventArchive({
    dir: targetDir,
    ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
    ...(options.maxFiles !== undefined ? { maxFiles: options.maxFiles } : {}),
  });
  try {
    if (events.length > 0) {
      await writer.append(events);
    }
  } finally {
    await writer.close();
  }

  return stats;
}
