import * as fs from "fs";
import * as path from "path";
import { redactError, redactText } from "../redact.js";

export type RefKind = "market" | "squad";

export interface Ref {
  kind: RefKind;
  id: string;
}

export interface FollowRecord {
  lastActivityAt: number;
  expiresAt: number;
}

export interface StoreFile {
  version: number;
  // chatId -> array of ref strings (e.g. "market:123")
  follows: Record<string, string[]>;
  // chatId -> ref -> activity/expiry metadata
  meta?: Record<string, Record<string, FollowRecord>>;
}

export const STORE_VERSION = 1;

export const DEFAULT_MAX_PER_CHAT = 50;

export const DEFAULT_MAX_TOTAL = 5000;

export class FollowStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FollowStoreError";
  }
}

export interface FollowStoreFs {
  readFileSync: (filePath: fs.PathOrFileDescriptor, encoding: BufferEncoding) => string;
  renameSync: (oldPath: fs.PathLike, newPath: fs.PathLike) => void;
  unlinkSync?: (filePath: fs.PathLike) => void;
}

/**
 * Configuration for `FollowStore`. Corrupt or unreadable files are moved to
 * `${filePath}.corrupt.<timestamp>`; if quarantine `rename` fails, source bytes
 * are retained in place (never unlinked) and a redacted `FollowStoreError` is thrown.
 *
 * `inactivityTtlMs`, when set, expires a follow once it has gone `inactivityTtlMs`
 * without activity. Activity is recorded on `follow()` and via `touch()`. Expired
 * follows are pruned on read; active follows are never removed by pruning.
 */
export interface FollowStoreOptions {
  filePath: string;
  maxPerChat?: number;
  maxTotal?: number;
  // Aliases for API compatibility.
  maxFollowsPerChat?: number;
  maxTotalEntries?: number;
  inactivityTtlMs?: number;
  fs?: Partial<FollowStoreFs>;
  now?: () => number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseRef(ref: string): Ref | null {
  if (typeof ref !== "string") return null;
  const idx = ref.indexOf(":");
  if (idx <= 0) return null;
  const kind = ref.slice(0, idx);
  const id = ref.slice(idx + 1);
  if (kind !== "market" && kind !== "squad") return null;
  if (!id) return null;
  // Reject whitespace, control characters and a second ':' in id, so a ref
  // always splits into exactly one kind and one id.
  if (/[\s\u0000-\u001F:]/.test(id)) return null;
  return { kind, id };
}

export function formatRef(kind: RefKind, id: string): string {
  return `${kind}:${id}`;
}

function emptyStore(): StoreFile {
  return { version: STORE_VERSION, follows: {}, meta: {} };
}

function validateMeta(
  raw: unknown,
  follows: Record<string, string[]>,
): Record<string, Record<string, FollowRecord>> {
  const meta: Record<string, Record<string, FollowRecord>> = {};
  if (raw === undefined) return meta;
  if (!isPlainObject(raw)) {
    throw new FollowStoreError("meta is not an object");
  }
  for (const [chatId, byRef] of Object.entries(raw)) {
    if (!isPlainObject(byRef)) {
      throw new FollowStoreError(`meta[${chatId}] is not an object`);
    }
    const out: Record<string, FollowRecord> = {};
    for (const [ref, rec] of Object.entries(byRef)) {
      if (
        !isPlainObject(rec) ||
        typeof rec.lastActivityAt !== "number" ||
        typeof rec.expiresAt !== "number" ||
        !Number.isFinite(rec.lastActivityAt) ||
        !Number.isFinite(rec.expiresAt)
      ) {
        throw new FollowStoreError(`invalid meta record for ${chatId}/${ref}`);
      }
      out[ref] = { lastActivityAt: rec.lastActivityAt, expiresAt: rec.expiresAt };
    }
    if (Object.keys(out).length > 0) meta[chatId] = out;
  }
  // Drop metadata for refs that are no longer followed.
  for (const chatId of Object.keys(meta)) {
    const list = follows[chatId] ?? [];
    for (const ref of Object.keys(meta[chatId])) {
      if (!list.includes(ref)) delete meta[chatId][ref];
    }
    if (Object.keys(meta[chatId]).length === 0) delete meta[chatId];
  }
  return meta;
}

function validateStoreFile(data: unknown): StoreFile {
  if (!isPlainObject(data)) {
    throw new FollowStoreError("store file is not an object");
  }
  if (data.version !== STORE_VERSION) {
    throw new FollowStoreError(`unsupported store version: ${String(data.version)}`);
  }
  if (!isPlainObject(data.follows)) {
    throw new FollowStoreError("follows is not an object");
  }
  const follows: Record<string, string[]> = {};
  for (const [chatId, list] of Object.entries(data.follows as Record<string, unknown>)) {
    if (!Array.isArray(list)) {
      throw new FollowStoreError(`follows[${chatId}] is not an array`);
    }
    const cleaned: string[] = [];
    for (const entry of list) {
      if (typeof entry !== "string" || parseRef(entry) === null) {
        throw new FollowStoreError(`invalid ref in follows[${chatId}]`);
      }
      cleaned.push(entry);
    }
    follows[chatId] = cleaned;
  }
  const meta = validateMeta(data.meta, follows);
  return { version: STORE_VERSION, follows, meta };
}

function quarantineFile(
  renameSync: FollowStoreFs["renameSync"],
  now: () => number,
  filePath: string,
  reason: string,
): void {
  const timestamp = now();
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const target = path.join(dir, `${base}.corrupt.${timestamp}`);
  try {
    renameSync(filePath, target);
  } catch (renameErr) {
    // Retain unreadable/corrupt bytes in place and raise a redacted actionable error.
    throw new FollowStoreError(
      `failed to quarantine unreadable follow store ${redactText(filePath)} to ${redactText(target)} (${redactText(reason)}): ${redactError(renameErr)}; source file retained in place — check directory permissions or move/repair the file`,
    );
  }
}

export class FollowStore {
  private readonly filePath: string;
  private readonly maxPerChat: number;
  private readonly maxTotal: number;
  private readonly inactivityTtlMs: number | undefined;
  private readonly readFileSync: FollowStoreFs["readFileSync"];
  private readonly renameSync: FollowStoreFs["renameSync"];
  private readonly now: () => number;

  constructor(options: FollowStoreOptions) {
    this.filePath = options.filePath;
    this.maxPerChat =
      options.maxPerChat ?? options.maxFollowsPerChat ?? DEFAULT_MAX_PER_CHAT;
    this.maxTotal = options.maxTotal ?? options.maxTotalEntries ?? DEFAULT_MAX_TOTAL;
    if (
      options.inactivityTtlMs !== undefined &&
      (!Number.isFinite(options.inactivityTtlMs) || options.inactivityTtlMs <= 0)
    ) {
      throw new FollowStoreError("inactivityTtlMs must be a positive finite number");
    }
    this.inactivityTtlMs = options.inactivityTtlMs;
    this.readFileSync =
      options.fs?.readFileSync ?? ((p, enc) => fs.readFileSync(p, enc));
    this.renameSync = options.fs?.renameSync ?? fs.renameSync;
    this.now = options.now ?? Date.now;
  }

  private read(): StoreFile {
    if (!fs.existsSync(this.filePath)) {
      return emptyStore();
    }
    let raw: string;
    try {
      raw = this.readFileSync(this.filePath, "utf8");
    } catch (err) {
      quarantineFile(this.renameSync, this.now, this.filePath, redactError(err));
      return emptyStore();
    }
    if (raw.trim() === "") {
      return emptyStore();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      quarantineFile(this.renameSync, this.now, this.filePath, redactError(err));
      return emptyStore();
    }
    try {
      return validateStoreFile(parsed);
    } catch (err) {
      quarantineFile(this.renameSync, this.now, this.filePath, redactError(err));
      return emptyStore();
    }
  }

  private write(data: StoreFile): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const payload = JSON.stringify(data, null, 2) + "\n";
    fs.writeFileSync(tmp, payload, "utf8");
    fs.renameSync(tmp, this.filePath);
  }

  /**
   * Removes follows whose expiry has passed. Active follows are kept. Returns
   * the number of pruned entries. No-op when no inactivity TTL is configured.
   */
  private pruneExpired(data: StoreFile): number {
    if (this.inactivityTtlMs === undefined) return 0;
    const cutoff = this.now();
    const meta = data.meta ?? {};
    let pruned = 0;
    for (const chatId of Object.keys(data.follows)) {
      const list = data.follows[chatId];
      const kept: string[] = [];
      for (const ref of list) {
        const rec = meta[chatId]?.[ref];
        if (rec && rec.expiresAt <= cutoff) {
          pruned += 1;
          if (meta[chatId]) delete meta[chatId][ref];
          continue;
        }
        kept.push(ref);
      }
      if (kept.length === 0) {
        delete data.follows[chatId];
        delete meta[chatId];
      } else {
        data.follows[chatId] = kept;
        if (meta[chatId] && Object.keys(meta[chatId]).length === 0) delete meta[chatId];
      }
    }
    data.meta = meta;
    return pruned;
  }

  private touchRecord(data: StoreFile, chatId: string, ref: string): void {
    if (this.inactivityTtlMs === undefined) return;
    const at = this.now();
    data.meta ??= {};
    data.meta[chatId] ??= {};
    data.meta[chatId][ref] = {
      lastActivityAt: at,
      expiresAt: at + this.inactivityTtlMs,
    };
  }

  private totalCount(data: StoreFile): number {
    let total = 0;
    for (const list of Object.values(data.follows)) total += list.length;
    return total;
  }

  private assertChatId(chatId: string): void {
    if (typeof chatId !== "string" || chatId.length === 0) {
      throw new FollowStoreError("chatId must be a non-empty string");
    }
  }

  follow(chatId: string, ref: string): boolean {
    this.assertChatId(chatId);
    if (parseRef(ref) === null) {
      throw new FollowStoreError(`invalid ref: ${ref}`);
    }
    const data = this.read();
    this.pruneExpired(data);
    const existing = data.follows[chatId] ?? [];
    if (existing.includes(ref)) {
      // Re-following an active entry counts as activity and refreshes expiry.
      if (this.inactivityTtlMs !== undefined) {
        this.touchRecord(data, chatId, ref);
        this.write(data);
      }
      return false;
    }
    if (existing.length >= this.maxPerChat) {
      throw new FollowStoreError(`per-chat follow limit reached (${this.maxPerChat})`);
    }
    if (this.totalCount(data) >= this.maxTotal) {
      throw new FollowStoreError(`total follow limit reached (${this.maxTotal})`);
    }
    data.follows[chatId] = [...existing, ref];
    this.touchRecord(data, chatId, ref);
    this.write(data);
    return true;
  }

  /**
   * Records activity for an existing follow, extending its expiry. Returns
   * false if the follow does not exist (or has already expired).
   */
  touch(chatId: string, ref: string): boolean {
    this.assertChatId(chatId);
    if (parseRef(ref) === null) {
      throw new FollowStoreError(`invalid ref: ${ref}`);
    }
    const data = this.read();
    this.pruneExpired(data);
    if (!(data.follows[chatId] ?? []).includes(ref)) {
      this.write(data);
      return false;
    }
    this.touchRecord(data, chatId, ref);
    this.write(data);
    return true;
  }

  /** Prunes expired follows and persists the result. Returns pruned count. */
  pruneExpiredFollows(): number {
    const data = this.read();
    const pruned = this.pruneExpired(data);
    if (pruned > 0) this.write(data);
    return pruned;
  }

  unfollow(chatId: string, ref: string): boolean {
    this.assertChatId(chatId);
    if (parseRef(ref) === null) {
      throw new FollowStoreError(`invalid ref: ${ref}`);
    }
    const data = this.read();
    const existing = data.follows[chatId];
    if (!existing || !existing.includes(ref)) {
      return false;
    }
    const next = existing.filter((entry) => entry !== ref);
    if (next.length === 0) {
      delete data.follows[chatId];
      if (data.meta) delete data.meta[chatId];
    } else {
      data.follows[chatId] = next;
      if (data.meta?.[chatId]) delete data.meta[chatId][ref];
    }
    this.write(data);
    return true;
  }

  list(chatId: string): string[] {
    this.assertChatId(chatId);
    const data = this.read();
    if (this.pruneExpired(data) > 0) this.write(data);
    return [...(data.follows[chatId] ?? [])];
  }

  followersOf(ref: string): string[] {
    if (parseRef(ref) === null) {
      throw new FollowStoreError(`invalid ref: ${ref}`);
    }
    const data = this.read();
    if (this.pruneExpired(data) > 0) this.write(data);
    const result: string[] = [];
    for (const [chatId, list] of Object.entries(data.follows)) {
      if (list.includes(ref)) result.push(chatId);
    }
    return result;
  }
}

export function createFollowStore(options: FollowStoreOptions): FollowStore {
  return new FollowStore(options);
}
