import { open, mkdir, readdir, unlink, chmod, readFile, writeFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { scanJsonReplacer } from "./events.js";
import type { DecodedEvent, ContractSource } from "./decode.js";
import type { GenericDecodedEvent, GenericEventPayload } from "./generic-decode.js";

/** Current on-disk schema version for archived decoded events. */
export const ARCHIVE_SCHEMA_VERSION = 1 as const;

export type ArchivableEvent = DecodedEvent | GenericDecodedEvent;

export interface ArchivedRecordMeta {
  schemaVersion: typeof ARCHIVE_SCHEMA_VERSION;
}

export type ArchivedRecord<T extends ArchivableEvent = ArchivableEvent> = T & ArchivedRecordMeta;

export type ArchiveSchemaSource =
  | "v1"
  | "legacy-unversioned"
  | "legacy-blocktime"
  | "legacy-envelope";

export interface ArchiveRecordContext {
  fileName?: string;
  lineNumber?: number;
  reviveBigInts?: boolean;
}

export interface ArchiveMigrateResult<T extends ArchivableEvent = ArchivableEvent> {
  event: T;
  migrated: boolean;
  source: ArchiveSchemaSource;
  kind: "typed" | "generic";
  version: number;
}

export interface EventArchiveOptions {
  dir: string;
  maxBytes?: number;
  maxFiles?: number;
  schemaVersion?: number;
}

export interface EventArchive {
  append(events: readonly ArchivableEvent[]): Promise<void>;
  close(): Promise<void>;
}

export interface ReadArchiveOptions {
  /** Yield valid records before a malformed record instead of discarding them. Defaults to false. */
  retainCommitted?: boolean;
  /** Revive bigint fields in event payloads from decimal strings. Defaults to false. */
  reviveBigInts?: boolean;
}

export type PrivacyFindingKind = "private_chat_id" | "secret_value";

export interface PrivacyFinding {
  kind: PrivacyFindingKind;
  fileName: string;
  lineNumber: number;
  jsonPath: string;
  /** Redacted preview of the matched value; never the raw secret. */
  preview: string;
}

export interface PrivacyReviewReport {
  filesScanned: number;
  recordsScanned: number;
  findings: PrivacyFinding[];
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

export class UnsupportedArchiveVersionError extends Error {
  readonly fileName: string;
  readonly lineNumber: number;
  readonly version: unknown;

  constructor(
    versionOrFileName: unknown,
    fileNameOrLine?: string | number,
    maybeLineOrVersion?: number | unknown,
  ) {
    let version: unknown;
    let fileName = "<unknown>";
    let lineNumber = 1;

    if (typeof fileNameOrLine === "number" && typeof versionOrFileName === "string") {
      fileName =
        path
          .basename(versionOrFileName)
          .replace(/[\x00-\x1f\x7f]/g, " ")
          .slice(0, 128) || "<unknown>";
      lineNumber = fileNameOrLine;
      version = maybeLineOrVersion;
    } else {
      version = versionOrFileName;
      if (typeof fileNameOrLine === "string") {
        fileName =
          path
            .basename(fileNameOrLine)
            .replace(/[\x00-\x1f\x7f]/g, " ")
            .slice(0, 128) || "<unknown>";
      }
      if (typeof maybeLineOrVersion === "number") {
        lineNumber = maybeLineOrVersion;
      }
    }

    const safeVersion = String(version).replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 32);
    super(
      `Unsupported archive schema version ${safeVersion} at ${fileName}:${lineNumber} (expected version ${ARCHIVE_SCHEMA_VERSION})`,
    );
    this.name = "UnsupportedArchiveVersionError";
    this.fileName = fileName;
    this.lineNumber = lineNumber;
    this.version = version;
  }
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MiB
const DEFAULT_MAX_FILES = 10;
const FILE_MODE = 0o600;

// Telegram chat ids: private chats are positive integers; groups/channels are negative.
const PRIVATE_CHAT_KEY_PATTERN = /^(chat_?id|chatId|chat_id_private|private_chat_id|from_?id|user_?id)$/i;
const SECRET_KEY_PATTERN = /(secret|token|password|passwd|api[_-]?key|private[_-]?key|seed|mnemonic)/i;
// Stellar secret seed (S...), 56 base32 chars.
const STELLAR_SECRET_SEED_PATTERN = /\bS[A-Z2-7]{55}\b/;
// Bot token shaped values: <digits>:<35+ url-safe chars>.
const BOT_TOKEN_PATTERN = /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/;

function formatArchiveFilename(index: number, timestamp: number): string {
  const ts = new Date(timestamp).toISOString().replace(/[:.]/g, "-");
  const idx = String(index).padStart(6, "0");
  return `events-${ts}-${idx}.jsonl`;
}

/** Explicitly stamp an archive record with the current archive schema version. */
export function toArchivedRecord<T extends ArchivableEvent>(event: T): ArchivedRecord<T> {
  return {
    ...event,
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
  };
}

const BIGINT_FIELDS: Record<string, readonly string[]> = {
  claim_challenged: ["stake"],
  market_settled: ["totalPaid", "totalFees", "owedToChallengers", "dust"],
  challenger_paid: ["stake", "gross", "fee", "net"],
  fee_claimed: ["amount"],
  withdrawal: ["amount"],
  withdrawal_pending: ["amount"],
  deposited: ["amount", "shares"],
  withdrawn: ["amount"],
  resolved: ["poolA", "poolB"],
  claimed: ["gross", "fee", "net"],
  fees_claimed: ["amount"],
  fee_accrued: ["amount"],
};

function revivePayloadBigInts(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const name = (payload as { name?: string }).name;
  if (!name || typeof name !== "string") return payload;
  const fields = BIGINT_FIELDS[name];
  if (!fields) return payload;
  const copy = { ...(payload as Record<string, unknown>) };
  for (const f of fields) {
    const val = copy[f];
    if (typeof val === "string" && /^-?\d+$/.test(val.trim())) {
      try {
        copy[f] = BigInt(val.trim());
      } catch {
        // keep string
      }
    }
  }
  return copy;
}

function unpackEnvelope(
  raw: unknown,
  context?: ArchiveRecordContext,
): {
  record: Record<string, unknown>;
  declaredVersion: unknown;
  isEnvelope: boolean;
} {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new MalformedArchiveRecordError(
      context?.fileName ?? "<unknown>",
      context?.lineNumber ?? 1,
    );
  }

  const obj = raw as Record<string, unknown>;

  let inner: Record<string, unknown> | null = null;
  let isEnvelope = false;

  if (obj.event && typeof obj.event === "object" && !Array.isArray(obj.event)) {
    inner = obj.event as Record<string, unknown>;
    isEnvelope = true;
  } else if (obj.record && typeof obj.record === "object" && !Array.isArray(obj.record)) {
    inner = obj.record as Record<string, unknown>;
    isEnvelope = true;
  }

  const envelopeVersion =
    obj.schemaVersion ?? (typeof obj.version === "number" ? obj.version : undefined);
  const target = inner ?? obj;
  const targetVersion =
    target.schemaVersion ?? (typeof target.version === "number" ? target.version : undefined);

  const declaredVersion = envelopeVersion ?? targetVersion ?? obj.format;

  return {
    record: target,
    declaredVersion,
    isEnvelope,
  };
}

function validateArchiveVersion(
  declaredVersion: unknown,
  context?: ArchiveRecordContext,
): { versionNumber: number; isHistorical: boolean; sourceKind: ArchiveSchemaSource } {
  if (declaredVersion === undefined || declaredVersion === null) {
    return { versionNumber: 1, isHistorical: true, sourceKind: "legacy-unversioned" };
  }

  if (typeof declaredVersion === "number") {
    if (declaredVersion === ARCHIVE_SCHEMA_VERSION) {
      return { versionNumber: 1, isHistorical: false, sourceKind: "v1" };
    }
    if (declaredVersion === 0) {
      return { versionNumber: 1, isHistorical: true, sourceKind: "legacy-unversioned" };
    }
    throw new UnsupportedArchiveVersionError(
      declaredVersion,
      context?.fileName,
      context?.lineNumber,
    );
  }

  if (typeof declaredVersion === "string") {
    const trimmed = declaredVersion.trim().toLowerCase();
    if (
      trimmed === "1" ||
      trimmed === "v1" ||
      trimmed === "mimir-archive-v1" ||
      trimmed === "archive-v1"
    ) {
      return { versionNumber: 1, isHistorical: false, sourceKind: "v1" };
    }
    if (trimmed === "0" || trimmed === "v0" || trimmed === "legacy") {
      return { versionNumber: 1, isHistorical: true, sourceKind: "legacy-unversioned" };
    }
    throw new UnsupportedArchiveVersionError(
      declaredVersion,
      context?.fileName,
      context?.lineNumber,
    );
  }

  throw new UnsupportedArchiveVersionError(
    declaredVersion,
    context?.fileName,
    context?.lineNumber,
  );
}

/**
 * Migration adapter that accepts an archived typed contract event and migrates
 * any historical schema variations (legacy unversioned, blockTime, txIndex,
 * envelopes) into a canonical notification-safe DecodedEvent.
 */
export function adaptArchivedTypedEvent(
  raw: unknown,
  context?: ArchiveRecordContext,
): DecodedEvent {
  const { record, declaredVersion } = unpackEnvelope(raw, context);
  validateArchiveVersion(declaredVersion, context);

  const at =
    typeof record.at === "number" && Number.isFinite(record.at)
      ? record.at
      : typeof record.blockTime === "number" && Number.isFinite(record.blockTime)
        ? record.blockTime
        : 0;

  const transactionIndex =
    record.transactionIndex !== undefined
      ? typeof record.transactionIndex === "number"
        ? record.transactionIndex
        : null
      : record.txIndex !== undefined && typeof record.txIndex === "number"
        ? record.txIndex
        : null;

  const operationIndex =
    record.operationIndex !== undefined
      ? typeof record.operationIndex === "number"
        ? record.operationIndex
        : null
      : null;

  const eventId =
    typeof record.eventId === "string"
      ? record.eventId
      : typeof record.id === "string" || typeof record.id === "number"
        ? String(record.id)
        : "";

  const ledger = typeof record.ledger === "number" ? record.ledger : 0;
  const txHash = typeof record.txHash === "string" ? record.txHash : "";

  const eventType = typeof record.eventType === "string" ? record.eventType : "contract";
  const inSuccessfulContractCall =
    record.inSuccessfulContractCall !== undefined
      ? Boolean(record.inSuccessfulContractCall)
      : true;

  const version =
    typeof record.version === "string" && record.version.length > 0
      ? record.version
      : "v1";

  const rawSource = typeof record.source === "string" ? record.source.toLowerCase() : "";
  const source: ContractSource = rawSource === "squad" ? "squad" : "market";

  const contractId = typeof record.contractId === "string" ? record.contractId : "";

  let payload =
    record.payload && typeof record.payload === "object"
      ? { ...(record.payload as Record<string, unknown>) }
      : null;
  if (!payload) {
    const topicName = typeof record.topicName === "string" ? record.topicName : "unknown";
    payload = { name: topicName };
  }

  if (context?.reviveBigInts) {
    payload = revivePayloadBigInts(payload) as any;
  }

  const migrated: any = {
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    source,
    contractId,
    version,
    ledger,
    txHash,
    at,
    eventId,
    eventType,
    transactionIndex,
    operationIndex,
    inSuccessfulContractCall,
    payload,
  };

  if (record.blockTime !== undefined) migrated.blockTime = record.blockTime;
  if (record.txIndex !== undefined) migrated.txIndex = record.txIndex;
  if (record.topicName !== undefined) migrated.topicName = record.topicName;
  if (record.id !== undefined && record.eventId === undefined) migrated.id = record.id;

  return migrated as DecodedEvent;
}

/**
 * Migration adapter that accepts an archived generic contract event and migrates
 * any historical schema variations into a canonical notification-safe GenericDecodedEvent.
 */
export function adaptArchivedGenericEvent(
  raw: unknown,
  context?: ArchiveRecordContext,
): GenericDecodedEvent {
  const { record, declaredVersion } = unpackEnvelope(raw, context);
  validateArchiveVersion(declaredVersion, context);

  const at =
    typeof record.at === "number" && Number.isFinite(record.at)
      ? record.at
      : typeof record.blockTime === "number" && Number.isFinite(record.blockTime)
        ? record.blockTime
        : 0;

  const transactionIndex =
    record.transactionIndex !== undefined
      ? typeof record.transactionIndex === "number"
        ? record.transactionIndex
        : null
      : record.txIndex !== undefined && typeof record.txIndex === "number"
        ? record.txIndex
        : null;

  const operationIndex =
    record.operationIndex !== undefined
      ? typeof record.operationIndex === "number"
        ? record.operationIndex
        : null
      : null;

  const eventId =
    typeof record.eventId === "string"
      ? record.eventId
      : typeof record.id === "string" || typeof record.id === "number"
        ? String(record.id)
        : "";

  const ledger = typeof record.ledger === "number" ? record.ledger : 0;
  const txHash = typeof record.txHash === "string" ? record.txHash : "";
  const eventType = typeof record.eventType === "string" ? record.eventType : "contract";
  const inSuccessfulContractCall =
    record.inSuccessfulContractCall !== undefined
      ? Boolean(record.inSuccessfulContractCall)
      : true;
  const source =
    typeof record.source === "string" && record.source.length > 0 ? record.source : "generic";
  const contractId = typeof record.contractId === "string" ? record.contractId : "";

  const rawPayload =
    record.payload && typeof record.payload === "object"
      ? (record.payload as Record<string, unknown>)
      : undefined;

  const eventName =
    typeof record.eventName === "string"
      ? record.eventName
      : typeof record.topicName === "string"
        ? record.topicName
        : rawPayload && typeof rawPayload.eventName === "string"
          ? rawPayload.eventName
          : "unknown";

  const topics: string[] = Array.isArray(record.topics)
    ? record.topics.map(String)
    : rawPayload && Array.isArray(rawPayload.topics)
      ? rawPayload.topics.map(String)
      : [];

  const value =
    typeof record.value === "string"
      ? record.value
      : rawPayload && typeof rawPayload.value === "string"
        ? rawPayload.value
        : "()";

  const topicSummary =
    typeof record.topicSummary === "string"
      ? record.topicSummary
      : topics.length > 0
        ? topics.join(" | ")
        : eventName;

  const valueSummary =
    typeof record.valueSummary === "string" ? record.valueSummary : value;

  const summary =
    typeof record.summary === "string"
      ? record.summary
      : rawPayload && typeof rawPayload.summary === "string"
        ? rawPayload.summary
        : `[${eventName}] ${topicSummary} => ${valueSummary}`;

  const payload: GenericEventPayload = {
    name: "generic",
    eventName,
    topics,
    value,
    summary,
    ...(rawPayload && typeof rawPayload.reason === "string" ? { reason: rawPayload.reason } : {}),
  };

  const migrated: any = {
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    source,
    contractId,
    ledger,
    txHash,
    at,
    eventId,
    eventType,
    transactionIndex,
    operationIndex,
    inSuccessfulContractCall,
    eventName,
    topics,
    value,
    topicSummary,
    valueSummary,
    summary,
    payload,
  };

  if (record.blockTime !== undefined) migrated.blockTime = record.blockTime;
  if (record.txIndex !== undefined) migrated.txIndex = record.txIndex;
  if (record.topicName !== undefined) migrated.topicName = record.topicName;
  if (record.id !== undefined && record.eventId === undefined) migrated.id = record.id;

  return migrated as GenericDecodedEvent;
}

function isGenericArchivedRecord(rec: Record<string, unknown>): boolean {
  if (rec.payload && typeof rec.payload === "object" && (rec.payload as any).name === "generic") {
    return true;
  }
  if (rec.source === "generic") {
    return true;
  }
  if (Array.isArray(rec.topics) && typeof rec.value === "string" && !rec.source) {
    return true;
  }
  return false;
}

/**
 * Detailed migration result for an archived record, indicating whether it was
 * migrated from a legacy shape, its schema source, and whether it is typed or generic.
 */
export function migrateArchivedRecordDetailed(
  raw: unknown,
  context?: ArchiveRecordContext,
): ArchiveMigrateResult {
  const { record, declaredVersion, isEnvelope } = unpackEnvelope(raw, context);
  const versionInfo = validateArchiveVersion(declaredVersion, context);

  let sourceKind: ArchiveSchemaSource = versionInfo.sourceKind;
  if (isEnvelope && sourceKind === "v1") {
    sourceKind = "legacy-envelope";
  } else if (record.blockTime !== undefined && record.at === undefined) {
    sourceKind = "legacy-blocktime";
  }

  const isGeneric = isGenericArchivedRecord(record);
  const event = isGeneric
    ? adaptArchivedGenericEvent(raw, context)
    : adaptArchivedTypedEvent(raw, context);

  const migrated = versionInfo.isHistorical || isEnvelope || sourceKind !== "v1";

  return {
    event,
    migrated,
    source: sourceKind,
    kind: isGeneric ? "generic" : "typed",
    version: versionInfo.versionNumber,
  };
}

/**
 * Universal migration adapter: parses, validates, and migrates any archived decoded
 * event record (typed or generic, versioned or historical) into its canonical form.
 * Throws UnsupportedArchiveVersionError on unknown schema versions.
 */
export function migrateArchivedRecord<T extends ArchivableEvent = DecodedEvent>(
  raw: unknown,
  context?: ArchiveRecordContext,
): T {
  return migrateArchivedRecordDetailed(raw, context).event as T;
}

export const migrateArchivedEvent = migrateArchivedRecord;

export function isArchivedEvent(value: unknown): value is ArchivableEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.ledger === "number" &&
    typeof obj.eventId === "string" &&
    obj.payload !== undefined &&
    typeof obj.payload === "object"
  );
}

export function createEventArchive(options: EventArchiveOptions): EventArchive {
  const { dir, metadata } = options;
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

    if (hasMetadata && currentSize === 0) {
      const header = JSON.stringify({ type: "metadata", ...metadata }) + "\n";
      const headerBuf = Buffer.from(header, "utf8");
      await currentHandle.write(headerBuf);
      await currentHandle.sync();
      currentSize += headerBuf.byteLength;
    }
  }

  async function doAppend(events: readonly ArchivableEvent[]): Promise<void> {
    if (closed) {
      throw new Error("Event archive is closed");
    }
    await ensureWriterSchema();
    if (!events || events.length === 0) return;

    for (const event of events) {
      const record = toArchivedRecord(event);
      const line = JSON.stringify(record, scanJsonReplacer) + "\n";
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
    async append(events: readonly ArchivableEvent[]): Promise<void> {
      queue = queue.then(() => doAppend(events));
      return queue;
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

export async function* readArchive<T extends ArchivableEvent = DecodedEvent>(
  dir: string,
  options: ReadArchiveOptions = {},
): AsyncGenerator<T, void, unknown> {
  const files = await listArchiveFiles(dir);
  const stagedEvents: T[] = [];
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

        let migrated: T;
        try {
          migrated = migrateArchivedRecord<T>(parsed, {
            fileName: file,
            lineNumber: index + 1,
            reviveBigInts: options.reviveBigInts,
          });
        } catch (err) {
          if (
            err instanceof UnsupportedArchiveVersionError ||
            err instanceof MalformedArchiveRecordError
          ) {
            throw err;
          }
          throw new MalformedArchiveRecordError(file, index + 1);
        }

        if (retainCommitted) {
          yield migrated;
        } else {
          stagedEvents.push(migrated);
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

function redactPreview(value: string): string {
  if (value.length <= 4) return "****";
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

function scanValue(
  value: unknown,
  jsonPath: string,
  keyHint: string | undefined,
  emit: (kind: PrivacyFindingKind, jsonPath: string, raw: string) => void,
): void {
  if (typeof value === "string") {
    if (keyHint && PRIVATE_CHAT_KEY_PATTERN.test(keyHint) && /^\d+$/.test(value)) {
      emit("private_chat_id", jsonPath, value);
    } else if (keyHint && SECRET_KEY_PATTERN.test(keyHint) && value.length > 0) {
      emit("secret_value", jsonPath, value);
    } else {
      const seed = value.match(STELLAR_SECRET_SEED_PATTERN);
      if (seed) emit("secret_value", jsonPath, seed[0]);
      const token = value.match(BOT_TOKEN_PATTERN);
      if (token) emit("secret_value", jsonPath, token[0]);
    }
    return;
  }
  if (typeof value === "number" && keyHint && PRIVATE_CHAT_KEY_PATTERN.test(keyHint)) {
    if (Number.isInteger(value) && value > 0) {
      emit("private_chat_id", jsonPath, String(value));
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => scanValue(item, `${jsonPath}[${i}]`, undefined, emit));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      scanValue(child, `${jsonPath}.${key}`, key, emit);
    }
  }
}

/**
 * Deterministically scan archived JSONL records for private chat identifiers and
 * secret-shaped values. Reads only local archive files; performs no network I/O.
 */
export async function reviewArchivePrivacy(dir: string): Promise<PrivacyReviewReport> {
  const files = await listArchiveFiles(dir);
  const findings: PrivacyFinding[] = [];
  let recordsScanned = 0;

  for (const file of files) {
    const handle = await open(path.join(dir, file), "r");
    try {
      const content = await handle.readFile({ encoding: "utf8" });
      const lines = content.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const trimmed = lines[index]!.trim();
        if (!trimmed) continue;
        recordsScanned += 1;
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          throw new MalformedArchiveRecordError(file, index + 1);
        }
        scanValue(parsed, "$", undefined, (kind, jsonPath, raw) => {
          findings.push({
            kind,
            fileName: file,
            lineNumber: index + 1,
            jsonPath,
            preview: redactPreview(raw),
          });
        });
      }
    } finally {
      await handle.close();
    }
  }

  return { filesScanned: files.length, recordsScanned, findings };
}
