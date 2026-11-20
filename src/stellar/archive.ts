import { open, mkdir, readdir, unlink, chmod, readFile, writeFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { scanJsonReplacer } from "./events.js";
import type { DecodedEvent } from "./decode.js";
import {
  ARCHIVE_SCHEMA_FORMAT,
  DEFAULT_ARCHIVE_SCHEMA_VERSION,
  SUPPORTED_ARCHIVE_READER_VERSIONS,
  SUPPORTED_ARCHIVE_WRITER_VERSIONS,
  UnsupportedArchiveSchemaError,
  getSupportedArchiveSchemaVersions,
  negotiateArchiveSchemaVersion,
  type ArchiveSchemaCapabilities,
  type ArchiveSchemaErrorCode,
  type SchemaNegotiationRequest,
} from "./scan-jsonl.js";

export {
  ARCHIVE_SCHEMA_FORMAT,
  DEFAULT_ARCHIVE_SCHEMA_VERSION,
  SUPPORTED_ARCHIVE_READER_VERSIONS,
  SUPPORTED_ARCHIVE_WRITER_VERSIONS,
  UnsupportedArchiveSchemaError,
  getSupportedArchiveSchemaVersions,
  negotiateArchiveSchemaVersion,
  type ArchiveSchemaCapabilities,
  type ArchiveSchemaErrorCode,
  type SchemaNegotiationRequest,
};

export const ARCHIVE_SCHEMA_FILENAME = "archive-schema.json" as const;

export interface ArchiveSchemaFile {
  format: typeof ARCHIVE_SCHEMA_FORMAT;
  schemaVersion: number;
}

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
  const { dir } = options;
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
        let parsed: DecodedEvent;
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

        if (retainCommitted) {
          yield parsed;
        } else {
          stagedEvents.push(parsed);
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
