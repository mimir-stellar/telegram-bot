import { open, mkdir, readdir, unlink, chmod } from "node:fs/promises";
import path from "node:path";
import { scanJsonReplacer } from "./events.js";
import type { DecodedEvent } from "./decode.js";

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

function isMetadataRecord(value: unknown): value is { type: "metadata"; network?: unknown; contractId?: unknown } {
  return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "metadata";
}

/**
 * Validate archive metadata across all files in `dir` before event iteration begins.
 * Rejects archives with contradictory network or contractId metadata.
 */
export async function validateArchiveMetadata(
  dir: string,
  options: Pick<ReadArchiveOptions, "expectedNetwork" | "expectedContractId"> = {},
): Promise<ArchiveMetadata> {
  const files = await listArchiveFiles(dir);
  let observedNetwork: string | undefined;
  let observedContractId: string | undefined;

  for (const file of files) {
    const filePath = path.join(dir, file);
    const handle = await open(filePath, "r");
    try {
      const content = await handle.readFile({ encoding: "utf8" });
      const lines = content.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const trimmed = lines[index]!.trim();
        if (!trimmed) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          // Malformed JSON lines are handled during iteration so retainCommitted continues to work.
          continue;
        }

        if (isMetadataRecord(parsed)) {
          const net = typeof parsed.network === "string" ? parsed.network : undefined;
          const cid = typeof parsed.contractId === "string" ? parsed.contractId : undefined;

          if (options.expectedNetwork !== undefined && net !== undefined && net !== options.expectedNetwork) {
            throw new ArchiveMetadataConflictError(
              `Archive network "${net}" contradicts expected network "${options.expectedNetwork}"`,
            );
          }
          if (options.expectedContractId !== undefined && cid !== undefined && cid !== options.expectedContractId) {
            throw new ArchiveMetadataConflictError(
              `Archive contractId "${cid}" contradicts expected contractId "${options.expectedContractId}"`,
            );
          }
          if (observedNetwork !== undefined && net !== undefined && net !== observedNetwork) {
            throw new ArchiveMetadataConflictError(
              `Contradictory archive network metadata: "${observedNetwork}" vs "${net}"`,
            );
          }
          if (observedContractId !== undefined && cid !== undefined && cid !== observedContractId) {
            throw new ArchiveMetadataConflictError(
              `Contradictory archive contractId metadata: "${observedContractId}" vs "${cid}"`,
            );
          }
          if (net !== undefined) observedNetwork = net;
          if (cid !== undefined) observedContractId = cid;
        } else if (typeof parsed === "object" && parsed !== null) {
          const eventContractId = (parsed as { contractId?: unknown }).contractId;
          const expectedCid = options.expectedContractId ?? observedContractId;
          if (
            expectedCid !== undefined &&
            typeof eventContractId === "string" &&
            eventContractId !== expectedCid
          ) {
            throw new ArchiveMetadataConflictError(
              `Event contractId "${eventContractId}" contradicts expected contractId "${expectedCid}"`,
            );
          }
        }
      }
    } finally {
      await handle.close();
    }
  }

  return {
    ...(observedNetwork !== undefined ? { network: observedNetwork } : {}),
    ...(observedContractId !== undefined ? { contractId: observedContractId } : {}),
  };
}

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
      const lines = content.split("\n");
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
