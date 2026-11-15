/**
 * Durable one-time callback confirmation identity ledger.
 *
 * Binds operator confirmation prompts (`/pause` and `/broadcast`) to
 * `(actorId, chatId, action, id)` using SHA-256 digests and persists both
 * pending prompts and settled tombstones (`consumed`, `cancelled`, `expired`)
 * across process restarts.
 *
 * Privacy & safety invariants:
 * - Raw Telegram user IDs, chat IDs, and broadcast announcement bodies are
 *   never written to disk; only salted namespace SHA-256 hashes, timestamps,
 *   action type, and lifecycle status are persisted.
 * - `filePath: null | undefined | ""` keeps the ledger purely in-memory so
 *   credential-free unit tests never touch `./data` unless they opt in.
 * - Writes use atomic temporary-file creation (`0o600`), `fsync`, and `rename`,
 *   with bounded record capacity (`maxRecords`) and tombstone retention.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";

import { safeErrorMessage } from "./notifications/format.js";

export const CONFIRMATION_STATE_VERSION = 1;
export const DEFAULT_CONFIRMATION_MAX_RECORDS = 500;
export const DEFAULT_CONFIRMATION_TOMBSTONE_RETENTION_MS = 24 * 60 * 60 * 1000;
export const PAUSE_CONFIRM_TTL_MS = 60_000;

/**
 * Derive a deterministic confirmation identifier for a `/pause` prompt message.
 * Uses Telegram's `message_id` when present, falling back to `message.date`
 * for lightweight test contexts that omit `message_id`.
 */
export function pauseConfirmationId(
  message: { message_id?: number; date?: number } | undefined,
): string {
  if (typeof message?.message_id === "number" && Number.isFinite(message.message_id)) {
    return `pause:msg:${message.message_id}`;
  }
  const dateSec =
    typeof message?.date === "number" && Number.isFinite(message.date) ? message.date : 0;
  return `pause:ts:${dateSec}`;
}

export type ConfirmationAction = "pause" | "broadcast";
export type ConfirmationRecordStatus = "pending" | "consumed" | "cancelled" | "expired";

export interface ConfirmationIdentityInput {
  id: string;
  actorId: string;
  chatId: string;
  action: ConfirmationAction;
}

export interface ConfirmationRecord {
  id: string;
  action: ConfirmationAction;
  actorHash: string;
  chatHash: string;
  bindingHash: string;
  status: ConfirmationRecordStatus;
  createdAt: number;
  expiresAt: number;
  settledAt?: number;
}

interface ConfirmationStateFile {
  version: typeof CONFIRMATION_STATE_VERSION;
  updatedAt: string;
  records: ConfirmationRecord[];
}

export interface ConfirmationIdentityStoreOptions {
  /** Path to the persisted JSON ledger. `null`/empty keeps state in-memory only. */
  filePath?: string | null | undefined;
  /** Maximum records retained in memory and on disk. Defaults to 500. */
  maxRecords?: number | undefined;
  /** How long settled/expired tombstones are retained to block replays. Defaults to 24h. */
  tombstoneRetentionMs?: number | undefined;
  /** Optional clock returning epoch milliseconds. Defaults to `Date.now`. */
  now?: (() => number) | undefined;
}

export type ConfirmationSettlementResult =
  | { ok: true; record: ConfirmationRecord }
  | {
      ok: false;
      reason: "binding-mismatch" | "replayed" | "expired" | "unknown";
      record?: ConfirmationRecord | undefined;
    };

export function hashConfirmationField(namespace: "actor" | "chat", value: string): string {
  return createHash("sha256")
    .update(`${namespace}:${String(value).trim()}`, "utf8")
    .digest("hex");
}

export function computeConfirmationBindingHash(input: ConfirmationIdentityInput): string {
  const id = String(input.id).trim();
  const actorId = String(input.actorId).trim();
  const chatId = String(input.chatId).trim();
  return createHash("sha256")
    .update(`v1\0${input.action}\0${actorId}\0${chatId}\0${id}`, "utf8")
    .digest("hex");
}

function isValidAction(value: unknown): value is ConfirmationAction {
  return value === "pause" || value === "broadcast";
}

function isValidStatus(value: unknown): value is ConfirmationRecordStatus {
  return (
    value === "pending" ||
    value === "consumed" ||
    value === "cancelled" ||
    value === "expired"
  );
}

function isHexSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function parseRecord(raw: unknown): ConfirmationRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id.trim().length === 0) return null;
  if (!isValidAction(r.action)) return null;
  if (!isHexSha256(r.actorHash) || !isHexSha256(r.chatHash) || !isHexSha256(r.bindingHash)) {
    return null;
  }
  if (!isValidStatus(r.status)) return null;
  if (typeof r.createdAt !== "number" || !Number.isFinite(r.createdAt)) return null;
  if (typeof r.expiresAt !== "number" || !Number.isFinite(r.expiresAt)) return null;
  if (r.settledAt !== undefined && (typeof r.settledAt !== "number" || !Number.isFinite(r.settledAt))) {
    return null;
  }
  return {
    id: r.id.trim(),
    action: r.action,
    actorHash: r.actorHash,
    chatHash: r.chatHash,
    bindingHash: r.bindingHash,
    status: r.status,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    ...(r.settledAt !== undefined ? { settledAt: r.settledAt } : {}),
  };
}

let tempSeq = 0;

export class ConfirmationIdentityStore {
  private readonly records = new Map<string, ConfirmationRecord>();
  private readonly filePath: string | null;
  private readonly maxRecords: number;
  private readonly tombstoneRetentionMs: number;
  private readonly clock: () => number;

  constructor(options: ConfirmationIdentityStoreOptions = {}) {
    const trimmedPath =
      typeof options.filePath === "string" ? options.filePath.trim() : "";
    this.filePath = trimmedPath.length > 0 ? trimmedPath : null;
    this.maxRecords = Math.max(1, Math.trunc(options.maxRecords ?? DEFAULT_CONFIRMATION_MAX_RECORDS));
    this.tombstoneRetentionMs = Math.max(
      1_000,
      Math.trunc(options.tombstoneRetentionMs ?? DEFAULT_CONFIRMATION_TOMBSTONE_RETENTION_MS),
    );
    this.clock = options.now ?? Date.now;

    if (this.filePath !== null) {
      this.loadFromDisk();
    }
  }

  /** Issue a new pending one-time confirmation bound to `(actorId, chatId, action)`. */
  issue(
    input: ConfirmationIdentityInput & {
      ttlMs: number;
      now?: number | undefined;
    },
  ): ConfirmationRecord {
    const at = input.now ?? this.clock();
    this.prune(at);

    const id = String(input.id).trim();
    const actorId = String(input.actorId).trim();
    const chatId = String(input.chatId).trim();
    const record: ConfirmationRecord = {
      id,
      action: input.action,
      actorHash: hashConfirmationField("actor", actorId),
      chatHash: hashConfirmationField("chat", chatId),
      bindingHash: computeConfirmationBindingHash({
        id,
        actorId,
        chatId,
        action: input.action,
      }),
      status: "pending",
      createdAt: at,
      expiresAt: at + input.ttlMs,
    };

    this.records.delete(id);
    this.records.set(id, record);
    this.enforceCap();
    this.persistToDisk(at);
    return { ...record };
  }

  /** Read a stored confirmation record without mutating its status. */
  getRecord(id: string): ConfirmationRecord | undefined {
    const rec = this.records.get(String(id).trim());
    return rec ? { ...rec } : undefined;
  }

  /**
   * Verify `(actorId, chatId, action)` binding, replay state, and expiry for `id`,
   * atomically transitioning valid pending confirmations to `targetStatus`.
   *
   * On `binding-mismatch`, the stored record is left untouched so a cross-chat or
   * forged callback cannot consume or cancel the legitimate pending action.
   */
  verifyAndSettle(
    input: ConfirmationIdentityInput & {
      targetStatus: "consumed" | "cancelled";
      now?: number | undefined;
      /**
       * Optional implicit creation parameters used for legacy/stateless prompts
       * (such as `/pause` callbacks where only `message.date` was observed before
       * persistence was attached). Settles a tombstone on first use so replays are
       * still blocked across restarts.
       */
      implicitCreatedAtMs?: number | undefined;
      implicitTtlMs?: number | undefined;
    },
  ): ConfirmationSettlementResult {
    const at = input.now ?? this.clock();
    this.prune(at);

    const id = String(input.id).trim();
    const actorId = String(input.actorId).trim();
    const chatId = String(input.chatId).trim();

    if (!id || !actorId || !chatId) {
      return { ok: false, reason: "binding-mismatch" };
    }

    const expectedActorHash = hashConfirmationField("actor", actorId);
    const expectedChatHash = hashConfirmationField("chat", chatId);
    const expectedBindingHash = computeConfirmationBindingHash({
      id,
      actorId,
      chatId,
      action: input.action,
    });

    const existing = this.records.get(id);
    if (existing) {
      if (
        existing.action !== input.action ||
        existing.actorHash !== expectedActorHash ||
        existing.chatHash !== expectedChatHash ||
        existing.bindingHash !== expectedBindingHash
      ) {
        return { ok: false, reason: "binding-mismatch", record: { ...existing } };
      }

      if (existing.status === "consumed" || existing.status === "cancelled") {
        return { ok: false, reason: "replayed", record: { ...existing } };
      }

      if (existing.status === "expired" || at > existing.expiresAt) {
        if (existing.status !== "expired") {
          existing.status = "expired";
          existing.settledAt = at;
          this.persistToDisk(at);
        }
        return { ok: false, reason: "expired", record: { ...existing } };
      }

      existing.status = input.targetStatus;
      existing.settledAt = at;
      this.persistToDisk(at);
      return { ok: true, record: { ...existing } };
    }

    if (input.implicitCreatedAtMs !== undefined && input.implicitTtlMs !== undefined) {
      const createdAt = input.implicitCreatedAtMs;
      const expiresAt = createdAt + input.implicitTtlMs;
      const expired = at > expiresAt;
      const implicitRecord: ConfirmationRecord = {
        id,
        action: input.action,
        actorHash: expectedActorHash,
        chatHash: expectedChatHash,
        bindingHash: expectedBindingHash,
        status: expired ? "expired" : input.targetStatus,
        createdAt,
        expiresAt,
        settledAt: at,
      };
      this.records.set(id, implicitRecord);
      this.enforceCap();
      this.persistToDisk(at);
      if (expired) {
        return { ok: false, reason: "expired", record: { ...implicitRecord } };
      }
      return { ok: true, record: { ...implicitRecord } };
    }

    return { ok: false, reason: "unknown" };
  }

  /**
   * Explicitly mark a pending confirmation as expired/invalidated (e.g. when a
   * pending broadcast lost its transient in-memory body across a restart).
   */
  markExpired(id: string, now?: number): boolean {
    const at = now ?? this.clock();
    const rec = this.records.get(String(id).trim());
    if (!rec) return false;
    if (rec.status === "pending") {
      rec.status = "expired";
      rec.settledAt = at;
      this.persistToDisk(at);
      return true;
    }
    return false;
  }

  size(): number {
    return this.records.size;
  }

  clear(): void {
    this.records.clear();
    this.persistToDisk(this.clock());
  }

  private prune(at: number): void {
    let changed = false;
    const cutoff = at - this.tombstoneRetentionMs;
    for (const [key, rec] of this.records.entries()) {
      const anchor = rec.settledAt ?? rec.expiresAt;
      if (rec.status !== "pending" && anchor <= cutoff) {
        this.records.delete(key);
        changed = true;
      } else if (rec.status === "pending" && rec.expiresAt <= cutoff) {
        this.records.delete(key);
        changed = true;
      }
    }
    if (changed) {
      this.persistToDisk(at);
    }
  }

  private enforceCap(): void {
    if (this.records.size <= this.maxRecords) return;

    // Evict settled/expired tombstones before active pending confirmations.
    for (const [key, rec] of this.records.entries()) {
      if (this.records.size <= this.maxRecords) break;
      if (rec.status !== "pending") {
        this.records.delete(key);
      }
    }
    while (this.records.size > this.maxRecords) {
      const oldest = this.records.keys().next().value;
      if (oldest === undefined) break;
      this.records.delete(oldest);
    }
  }

  private loadFromDisk(): void {
    if (!this.filePath) return;
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return;
      console.warn(
        `[bot] could not read confirmation state file: ${safeErrorMessage(err)}; starting fresh`,
      );
      return;
    }

    try {
      const parsed = JSON.parse(raw) as Partial<ConfirmationStateFile>;
      if (parsed?.version !== CONFIRMATION_STATE_VERSION || !Array.isArray(parsed.records)) {
        console.warn("[bot] confirmation state file has invalid schema; starting fresh");
        return;
      }
      for (const item of parsed.records) {
        const rec = parseRecord(item);
        if (rec) {
          this.records.set(rec.id, rec);
        }
      }
      this.enforceCap();
    } catch {
      console.warn("[bot] confirmation state file contains invalid JSON; starting fresh");
    }
  }

  private persistToDisk(at: number): void {
    if (!this.filePath) return;
    const dir = path.dirname(this.filePath);
    tempSeq = (tempSeq + 1) % 1_000_000;
    const tmpPath = `${this.filePath}.${process.pid}.${tempSeq}.tmp`;
    const payload: ConfirmationStateFile = {
      version: CONFIRMATION_STATE_VERSION,
      updatedAt: new Date(at).toISOString(),
      records: [...this.records.values()],
    };
    const serialized = `${JSON.stringify(payload, null, 2)}\n`;

    try {
      mkdirSync(dir, { recursive: true });
      const fd = openSync(tmpPath, "w", 0o600);
      try {
        writeSync(fd, serialized, undefined, "utf8");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmpPath, this.filePath);
    } catch (err) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // ignore cleanup error
      }
      console.warn(
        `[bot] failed to persist confirmation state: ${safeErrorMessage(err)}`,
      );
    }
  }
}
