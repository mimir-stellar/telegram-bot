import { open, mkdir, readdir, unlink, stat, chmod } from "node:fs/promises";
import path from "node:path";
import { type rpc, xdr } from "@stellar/stellar-sdk";
import type { ContractSource, DecodedEvent } from "./decode.js";
import { decodeRawEvent } from "./decode.js";
import { decodeGenericEvent, type GenericDecodedEvent } from "./generic-decode.js";
import { redactText } from "../redact.js";

/** Default byte capacity across all preserved quarantine records (10 MiB). */
export const DEFAULT_QUARANTINE_MAX_BYTES = 10 * 1024 * 1024;

/** Default maximum age before a quarantine file is pruned (7 days in ms). */
export const DEFAULT_QUARANTINE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Default max file size before rotating quarantine file (1 MiB). */
export const DEFAULT_QUARANTINE_ROTATION_BYTES = 1 * 1024 * 1024;

/** Hard ceiling on single envelope raw XDR bytes before rejection. */
export const MAX_QUARANTINE_ENVELOPE_BYTES = 64 * 1024;

const FILE_MODE = 0o600;

export interface EventQuarantineRecord {
  quarantinedAt: string;
  source: ContractSource | string;
  contractId: string;
  ledger: number;
  txHash: string;
  eventId: string;
  ledgerClosedAt?: string;
  reason: string;
  rawEnvelope: {
    topic: string[];
    value?: string | null;
  };
}

export interface EventQuarantineFs {
  open: typeof open;
  mkdir: typeof mkdir;
  readdir: typeof readdir;
  unlink: typeof unlink;
  stat: typeof stat;
  chmod: typeof chmod;
}

export interface EventQuarantineOptions {
  dir: string;
  maxBytes?: number;
  maxAgeMs?: number;
  maxFileBytes?: number;
  now?: () => number;
  fs?: Partial<EventQuarantineFs>;
}

export interface ReprocessResult {
  total: number;
  reprocessed: number;
  stillUndecodable: number;
  events: Array<DecodedEvent | GenericDecodedEvent>;
}

export interface ReprocessOptions {
  mode?: "typed" | "generic";
  version?: string;
  sourceOverride?: ContractSource;
}

function safeBase64Xdr(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    return trimmed;
  }
  const candidate = value as { toXDR?: (encoding?: string) => unknown };
  if (typeof candidate.toXDR === "function") {
    try {
      const res = candidate.toXDR("base64");
      if (typeof res === "string") return res;
      if (res instanceof Uint8Array || Buffer.isBuffer(res)) {
        return Buffer.from(res).toString("base64");
      }
    } catch {
      try {
        const rawBytes = candidate.toXDR();
        if (rawBytes instanceof Uint8Array || Buffer.isBuffer(rawBytes)) {
          return Buffer.from(rawBytes).toString("base64");
        }
      } catch {
        return null;
      }
    }
  }
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    return Buffer.from(value).toString("base64");
  }
  return null;
}

export function extractRawEnvelope(
  event: Partial<rpc.Api.EventResponse> & Record<string, unknown>,
): { topic: string[]; value?: string | null } {
  const topics: string[] = [];
  const rawTopics = Array.isArray(event.topic)
    ? event.topic
    : Array.isArray((event as { topics?: unknown }).topics)
      ? ((event as { topics: unknown[] }).topics)
      : [];

  for (const t of rawTopics) {
    const encoded = safeBase64Xdr(t);
    if (encoded) {
      topics.push(encoded);
    }
  }

  const rawVal = event.value;
  const value = safeBase64Xdr(rawVal);

  return {
    topic: topics,
    value: value ?? undefined,
  };
}

function formatQuarantineFilename(index: number, timestamp: number): string {
  const ts = new Date(timestamp).toISOString().replace(/[:.]/g, "-");
  const idx = String(index).padStart(6, "0");
  return `quarantine-${ts}-${idx}.jsonl`;
}

async function listQuarantineFiles(
  dir: string,
  readdirFn: typeof readdir,
): Promise<string[]> {
  try {
    const entries = await readdirFn(dir);
    return entries
      .filter((name) => name.startsWith("quarantine-") && name.endsWith(".jsonl"))
      .sort();
  } catch {
    return [];
  }
}

export class EventQuarantine {
  private readonly dir: string;
  private readonly maxBytes: number;
  private readonly maxAgeMs: number;
  private readonly maxFileBytes: number;
  private readonly now: () => number;
  private readonly openFn: typeof open;
  private readonly mkdirFn: typeof mkdir;
  private readonly readdirFn: typeof readdir;
  private readonly unlinkFn: typeof unlink;
  private readonly statFn: typeof stat;
  private readonly chmodFn: typeof chmod;

  private currentHandle: any = null;
  private currentFilePath: string | null = null;
  private currentSize: number = 0;
  private fileIndex: number = 0;
  private closed: boolean = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: EventQuarantineOptions) {
    this.dir = path.resolve(options.dir);
    this.maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_QUARANTINE_MAX_BYTES);
    this.maxAgeMs = Math.max(1, options.maxAgeMs ?? DEFAULT_QUARANTINE_MAX_AGE_MS);
    this.maxFileBytes = Math.max(1, options.maxFileBytes ?? DEFAULT_QUARANTINE_ROTATION_BYTES);
    this.now = options.now ?? Date.now;

    this.openFn = options.fs?.open ?? open;
    this.mkdirFn = options.fs?.mkdir ?? mkdir;
    this.readdirFn = options.fs?.readdir ?? readdir;
    this.unlinkFn = options.fs?.unlink ?? unlink;
    this.statFn = options.fs?.stat ?? stat;
    this.chmodFn = options.fs?.chmod ?? chmod;
  }

  private async pruneOldAndExceededFiles(): Promise<void> {
    const currentTime = this.now();
    const files = await listQuarantineFiles(this.dir, this.readdirFn);
    let totalBytes = 0;
    const fileStats: Array<{ file: string; path: string; size: number; mtimeMs: number }> = [];

    for (const f of files) {
      const fullPath = path.join(this.dir, f);
      try {
        const s = await this.statFn(fullPath);
        // Parse timestamp from quarantine filename if available: quarantine-<ts>-<idx>.jsonl
        let timestamp = s.mtimeMs;
        const match = /^quarantine-(.+)-\d{6}\.jsonl$/.exec(f);
        if (match && match[1]) {
          // parse ISO string back from 2026-11-19T00-00-00-000Z
          const normalized = match[1].replace(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/, "$1T$2:$3:$4.$5Z");
          const parsed = Date.parse(normalized);
          if (Number.isFinite(parsed)) {
            timestamp = parsed;
          }
        }
        fileStats.push({ file: f, path: fullPath, size: s.size, mtimeMs: timestamp });
        totalBytes += s.size;
      } catch {
        // file might have been unlinked or inaccessible
      }
    }

    // 1. Prune files older than maxAgeMs (except active file if it's currently writing)
    for (let i = fileStats.length - 1; i >= 0; i--) {
      const item = fileStats[i]!;
      if (item.path === this.currentFilePath) continue;
      const age = currentTime - item.mtimeMs;
      if (age > this.maxAgeMs) {
        try {
          await this.unlinkFn(item.path);
          totalBytes -= item.size;
          fileStats.splice(i, 1);
        } catch {
          // best-effort
        }
      }
    }

    // 2. Prune oldest files if totalBytes exceeds maxBytes
    let idx = 0;
    while (totalBytes > this.maxBytes && idx < fileStats.length) {
      const item = fileStats[idx]!;
      if (item.path === this.currentFilePath) {
        idx++;
        continue;
      }
      try {
        await this.unlinkFn(item.path);
        totalBytes -= item.size;
        fileStats.splice(idx, 1);
      } catch {
        idx++;
      }
    }
  }

  private async rotateIfNeeded(additionalBytes: number): Promise<void> {
    if (this.currentHandle && this.currentSize + additionalBytes <= this.maxFileBytes) {
      return;
    }

    if (this.currentHandle) {
      await this.currentHandle.sync();
      await this.currentHandle.close();
      this.currentHandle = null;
      this.currentFilePath = null;
    }

    await this.mkdirFn(this.dir, { recursive: true });
    await this.pruneOldAndExceededFiles();

    this.fileIndex += 1;
    const filename = formatQuarantineFilename(this.fileIndex, this.now());
    this.currentFilePath = path.join(this.dir, filename);

    this.currentHandle = await this.openFn(this.currentFilePath, "a+", FILE_MODE);
    try {
      await this.chmodFn(this.currentFilePath, FILE_MODE);
    } catch {
      // ignore on filesystems that do not support chmod
    }

    const st = await this.currentHandle.stat();
    this.currentSize = st.size;
  }

  private async doQuarantine(
    rawEvent: Partial<rpc.Api.EventResponse> & Record<string, unknown>,
    source: ContractSource | string,
    reason: string,
  ): Promise<EventQuarantineRecord> {
    if (this.closed) {
      throw new Error("Event quarantine is closed");
    }

    const rawEnvelope = extractRawEnvelope(rawEvent);
    const rawContractId = (rawEvent as Record<string, unknown>).contractId;
    const contractId =
      typeof rawContractId === "string"
        ? rawContractId.trim()
        : rawContractId && typeof rawContractId === "object"
          ? String((rawContractId as { toString?: () => string }).toString?.() ?? "")
          : "";

    const ledger =
      typeof rawEvent.ledger === "number" && Number.isFinite(rawEvent.ledger)
        ? Math.floor(rawEvent.ledger)
        : 0;

    const txHash = typeof rawEvent.txHash === "string" ? rawEvent.txHash.trim() : "";
    const eventId = typeof rawEvent.id === "string" ? rawEvent.id.trim() : "";
    const ledgerClosedAt =
      typeof rawEvent.ledgerClosedAt === "string" ? rawEvent.ledgerClosedAt : undefined;

    const record: EventQuarantineRecord = {
      quarantinedAt: new Date(this.now()).toISOString(),
      source,
      contractId,
      ledger,
      txHash,
      eventId,
      ...(ledgerClosedAt ? { ledgerClosedAt } : {}),
      reason: redactText(reason, { maxLen: 300 }),
      rawEnvelope,
    };

    const line = JSON.stringify(record) + "\n";
    const buffer = Buffer.from(line, "utf8");
    const bytes = buffer.byteLength;

    if (bytes > MAX_QUARANTINE_ENVELOPE_BYTES) {
      throw new Error(
        `Quarantine record exceeds maximum envelope byte ceiling (${bytes} > ${MAX_QUARANTINE_ENVELOPE_BYTES})`,
      );
    }

    if (!this.currentHandle || this.currentSize + bytes > this.maxFileBytes) {
      await this.rotateIfNeeded(bytes);
    }

    await this.currentHandle.write(buffer);
    await this.currentHandle.sync();
    this.currentSize += bytes;

    return record;
  }

  async quarantine(
    rawEvent: Partial<rpc.Api.EventResponse> & Record<string, unknown>,
    source: ContractSource | string,
    reason: string,
  ): Promise<EventQuarantineRecord> {
    const queuePromise = this.queue.then(async () => {
      return this.doQuarantine(rawEvent, source, reason);
    });
    this.queue = queuePromise.then(
      () => {},
      () => {},
    );
    return queuePromise;
  }

  async flush(): Promise<void> {
    await this.queue;
    if (this.currentHandle) {
      await this.currentHandle.sync();
    }
  }

  async close(): Promise<void> {
    this.queue = this.queue.then(async () => {
      if (this.closed) return;
      this.closed = true;
      if (this.currentHandle) {
        await this.currentHandle.sync();
        await this.currentHandle.close();
        this.currentHandle = null;
      }
    });
    return this.queue;
  }

  async *readRecords(): AsyncGenerator<EventQuarantineRecord, void, unknown> {
    await this.flush();
    const files = await listQuarantineFiles(this.dir, this.readdirFn);
    for (const file of files) {
      const fullPath = path.join(this.dir, file);
      const handle = await this.openFn(fullPath, "r");
      try {
        const content = await handle.readFile({ encoding: "utf8" });
        const lines = content.split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const parsed = JSON.parse(trimmed) as EventQuarantineRecord;
            yield parsed;
          } catch {
            // Ignore corrupted lines during readRecords
          }
        }
      } finally {
        await handle.close();
      }
    }
  }

  async reprocess(options: ReprocessOptions = {}): Promise<ReprocessResult> {
    const mode = options.mode ?? "typed";
    const version = options.version ?? "v1";
    const result: ReprocessResult = {
      total: 0,
      reprocessed: 0,
      stillUndecodable: 0,
      events: [],
    };

    for await (const record of this.readRecords()) {
      result.total += 1;
      const source = (options.sourceOverride ?? record.source) as ContractSource;

      if (mode === "generic") {
        const rawEvent: Record<string, unknown> = {
          contractId: record.contractId,
          ledger: record.ledger,
          txHash: record.txHash,
          id: record.eventId,
          ledgerClosedAt: record.ledgerClosedAt,
          topic: record.rawEnvelope.topic.map((t) => {
            try {
              return xdr.ScVal.fromXDR(Buffer.from(t, "base64"));
            } catch {
              return t;
            }
          }),
          value: record.rawEnvelope.value
            ? (() => {
                try {
                  return xdr.ScVal.fromXDR(Buffer.from(record.rawEnvelope.value, "base64"));
                } catch {
                  return record.rawEnvelope.value;
                }
              })()
            : undefined,
        };

        const decoded = decodeGenericEvent(rawEvent, String(source));
        result.events.push(decoded);
        result.reprocessed += 1;
      } else {
        try {
          const rawInput = {
            topic: record.rawEnvelope.topic,
            value: record.rawEnvelope.value ?? undefined,
            contractId: record.contractId,
            ledger: record.ledger,
            txHash: record.txHash,
            id: record.eventId,
            ledgerClosedAt: record.ledgerClosedAt,
          };
          const decoded = decodeRawEvent(source, rawInput, version);
          if (decoded.payload.name === "unknown") {
            result.stillUndecodable += 1;
          } else {
            result.reprocessed += 1;
          }
          result.events.push(decoded);
        } catch {
          result.stillUndecodable += 1;
        }
      }
    }

    return result;
  }
}

export function createEventQuarantine(options: EventQuarantineOptions): EventQuarantine {
  return new EventQuarantine(options);
}
