import { open, mkdir, readdir, readFile, rename, unlink, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { scanJsonReplacer } from "./events.js";
import type { DecodedEvent } from "./decode.js";
import {
  ARCHIVE_SCHEMA_FORMAT,
  DEFAULT_ARCHIVE_SCHEMA_VERSION,
  SCAN_JSONL_SCHEMA_FORMAT,
  SUPPORTED_ARCHIVE_READER_VERSIONS,
  SUPPORTED_ARCHIVE_WRITER_VERSIONS,
  UnsupportedArchiveSchemaError,
  getSupportedArchiveSchemaVersions,
  negotiateArchiveSchemaVersion,
  parseVersionedScanJsonl,
  type ArchiveSchemaCapabilities,
  type ArchiveSchemaErrorCode,
  type ParsedVersionedScanJsonl,
  type ReadScanJsonlSchemaOptions,
  type SchemaNegotiationRequest,
} from "./scan-jsonl.js";

export {
  ARCHIVE_SCHEMA_FORMAT,
  DEFAULT_ARCHIVE_SCHEMA_VERSION,
  SCAN_JSONL_SCHEMA_FORMAT,
  SUPPORTED_ARCHIVE_READER_VERSIONS,
  SUPPORTED_ARCHIVE_WRITER_VERSIONS,
  UnsupportedArchiveSchemaError,
  getSupportedArchiveSchemaVersions,
  negotiateArchiveSchemaVersion,
  parseVersionedScanJsonl,
  type ArchiveSchemaCapabilities,
  type ArchiveSchemaErrorCode,
  type ParsedVersionedScanJsonl,
  type ReadScanJsonlSchemaOptions,
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

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MiB
const DEFAULT_MAX_FILES = 10;
const FILE_MODE = 0o600;

function formatArchiveFilename(index: number, timestamp: number): string {
  const ts = new Date(timestamp).toISOString().replace(/[:.]/g, "-");
  const idx = String(index).padStart(6, "0");
  return `events-${ts}-${idx}.jsonl`;
}

async function readArchiveSchemaSidecar(
  dir: string,
  mode: "read" | "write",
  acceptedVersions?: readonly number[],
): Promise<number | null> {
  const filePath = path.join(dir, ARCHIVE_SCHEMA_FILENAME);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new UnsupportedArchiveSchemaError({
      code: "INVALID_SCHEMA_VERSION",
      message: `Malformed JSON in ${ARCHIVE_SCHEMA_FILENAME}: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UnsupportedArchiveSchemaError({
      code: "INVALID_SCHEMA_VERSION",
      message: `${ARCHIVE_SCHEMA_FILENAME} must contain a JSON object`,
    });
  }

  const obj = parsed as Record<string, unknown>;
  if (obj.format !== ARCHIVE_SCHEMA_FORMAT && obj.format !== "mimir-event-archive-v1") {
    const trailingVer =
      typeof obj.format === "string" ? /-v(\d+)$/.exec(obj.format) : null;
    if (trailingVer && trailingVer[1]) {
      const parsedVer = Number.parseInt(trailingVer[1], 10);
      if (parsedVer !== 1) {
        throw new UnsupportedArchiveSchemaError({
          code: "UNSUPPORTED_SCHEMA_VERSION",
          foundVersion: parsedVer,
          message: `Unsupported archive schema format "${obj.format}" (v${parsedVer}) in ${ARCHIVE_SCHEMA_FILENAME}`,
        });
      }
    }
    throw new UnsupportedArchiveSchemaError({
      code: "INCOMPATIBLE_SCHEMA_FORMAT",
      foundVersion: obj.format,
      message: `Incompatible format ${JSON.stringify(obj.format)} in ${ARCHIVE_SCHEMA_FILENAME}`,
    });
  }

  return negotiateArchiveSchemaVersion({
    mode,
    requestedVersion: obj.schemaVersion,
    acceptedVersions,
  });
}

async function writeArchiveSchemaSidecar(dir: string, schemaVersion: number): Promise<void> {
  await mkdir(dir, { recursive: true });
  const targetPath = path.join(dir, ARCHIVE_SCHEMA_FILENAME);
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  const doc: ArchiveSchemaFile = {
    format: ARCHIVE_SCHEMA_FORMAT,
    schemaVersion,
  };
  await writeFile(tmpPath, `${JSON.stringify(doc, null, 2)}\n`, {
    encoding: "utf8",
    mode: FILE_MODE,
  });
  try {
    await chmod(tmpPath, FILE_MODE);
  } catch {
    // ignore on filesystems without POSIX permissions
  }
  await rename(tmpPath, targetPath);
}

export function createEventArchive(options: EventArchiveOptions): EventArchive {
  const { dir } = options;
  const maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_MAX_BYTES);
  const maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES);
  const explicitVersionProvided = options.schemaVersion !== undefined;
  const writerVersion = negotiateArchiveSchemaVersion({
    mode: "write",
    requestedVersion: options.schemaVersion,
  });

  let schemaVerified = false;
  let currentHandle: any = null;
  let currentFilePath: string | null = null;
  let currentSize = 0;
  let fileIndex = 0;
  let closed = false;

  let queue: Promise<void> = Promise.resolve();

  async function ensureWriterSchema(): Promise<void> {
    if (schemaVerified) return;
    const existingVersion = await readArchiveSchemaSidecar(dir, "write");
    if (existingVersion !== null && existingVersion !== writerVersion) {
      throw new UnsupportedArchiveSchemaError({
        code: "SCHEMA_VERSION_CONFLICT",
        foundVersion: existingVersion,
        supportedVersions: SUPPORTED_ARCHIVE_WRITER_VERSIONS,
        message: `Archive directory schema v${existingVersion} conflicts with writer v${writerVersion}`,
      });
    }
    if (explicitVersionProvided && existingVersion === null) {
      await writeArchiveSchemaSidecar(dir, writerVersion);
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

async function loadVersionedArchive(
  dir: string,
  options: ReadScanJsonlSchemaOptions = {},
): Promise<{ negotiatedVersion: number; explicitVersionFound: boolean; events: DecodedEvent[] }> {
  const defaultNegotiated = negotiateArchiveSchemaVersion({
    mode: "read",
    acceptedVersions: options.acceptedVersions,
  });

  const sidecarVersion = await readArchiveSchemaSidecar(dir, "read", options.acceptedVersions);
  let resolvedExplicit: number | null = sidecarVersion;

  const files = await listArchiveFiles(dir);
  const allEvents: DecodedEvent[] = [];

  for (const file of files) {
    const handle = await open(path.join(dir, file), "r");
    try {
      const content = await handle.readFile({ encoding: "utf8" });
      const parsed = parseVersionedScanJsonl(content, {
        acceptedVersions: options.acceptedVersions,
        requireExplicitVersion: false,
      });
      if (parsed.explicitVersionFound) {
        if (resolvedExplicit !== null && resolvedExplicit !== parsed.negotiatedVersion) {
          throw new UnsupportedArchiveSchemaError({
            code: "SCHEMA_VERSION_CONFLICT",
            foundVersion: parsed.negotiatedVersion,
            message: `Archive segment "${file}" schema v${parsed.negotiatedVersion} conflicts with v${resolvedExplicit}`,
          });
        }
        resolvedExplicit = parsed.negotiatedVersion;
      }
      for (const ev of parsed.events) {
        allEvents.push(ev);
      }
    } finally {
      await handle.close();
    }
  }

  if (options.requireExplicitVersion && resolvedExplicit === null) {
    throw new UnsupportedArchiveSchemaError({
      code: "MISSING_SCHEMA_VERSION",
      message: `Archive "${dir}" does not declare an explicit schemaVersion`,
    });
  }

  return {
    negotiatedVersion: resolvedExplicit ?? defaultNegotiated,
    explicitVersionFound: resolvedExplicit !== null,
    events: allEvents,
  };
}

/**
 * Inspect and negotiate the schema version of an archive directory without
 * best-effort field guessing.
 */
export async function inspectArchiveSchema(
  dir: string,
  options: ReadScanJsonlSchemaOptions = {},
): Promise<{ negotiatedVersion: number; explicitVersionFound: boolean }> {
  const loaded = await loadVersionedArchive(dir, options);
  return {
    negotiatedVersion: loaded.negotiatedVersion,
    explicitVersionFound: loaded.explicitVersionFound,
  };
}

export async function* readArchive(
  dir: string,
  options: ReadScanJsonlSchemaOptions = {},
): AsyncGenerator<DecodedEvent, void, unknown> {
  const loaded = await loadVersionedArchive(dir, options);
  for (const ev of loaded.events) {
    yield ev;
  }
}
