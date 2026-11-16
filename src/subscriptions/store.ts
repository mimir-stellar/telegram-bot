import * as fs from "fs";
import * as path from "path";

export type RefKind = "market" | "squad";

export interface Ref {
  kind: RefKind;
  id: string;
}

export interface FollowEntryMetadata {
  lastActiveAt: number;
  expiresAt: number;
}

export interface StoreFile {
  version: number;
  // chatId -> array of ref strings (e.g. "market:123")
  follows: Record<string, string[]>;
  // chatId -> ref -> activity/expiry timestamps (ms since epoch)
  meta?: Record<string, Record<string, FollowEntryMetadata>>;
}

export const STORE_VERSION = 1;

export const DEFAULT_MAX_PER_CHAT = 50;

export const DEFAULT_MAX_TOTAL = 5000;

export const DEFAULT_INACTIVITY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export class FollowStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FollowStoreError";
  }
}

export interface FollowStoreOptions {
  filePath: string;
  maxPerChat?: number;
  maxTotal?: number;
  // Aliases for API compatibility.
  maxFollowsPerChat?: number;
  maxTotalEntries?: number;
  /** Inactivity window (ms) after which a follow expires; defaults to 30 days. */
  inactivityTtlMs?: number;
  /** Clock provider (ms since Unix epoch) for deterministic expiry testing. */
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
  return { version: STORE_VERSION, follows: {} };
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

  let meta: Record<string, Record<string, FollowEntryMetadata>> | undefined;
  if (data.meta !== undefined) {
    if (!isPlainObject(data.meta)) {
      throw new FollowStoreError("meta is not an object");
    }
    meta = {};
    for (const [chatId, rawChatMeta] of Object.entries(data.meta)) {
      if (!isPlainObject(rawChatMeta)) {
        throw new FollowStoreError(`meta[${chatId}] is not an object`);
      }
      const allowedRefs = new Set(follows[chatId] ?? []);
      const cleanedMeta: Record<string, FollowEntryMetadata> = {};
      for (const [ref, rawEntry] of Object.entries(rawChatMeta)) {
        if (parseRef(ref) === null) {
          throw new FollowStoreError(`invalid ref in meta[${chatId}]`);
        }
        if (
          !isPlainObject(rawEntry) ||
          typeof rawEntry.lastActiveAt !== "number" ||
          !Number.isFinite(rawEntry.lastActiveAt) ||
          typeof rawEntry.expiresAt !== "number" ||
          !Number.isFinite(rawEntry.expiresAt)
        ) {
          throw new FollowStoreError(`invalid metadata in meta[${chatId}][${ref}]`);
        }
        if (allowedRefs.has(ref)) {
          cleanedMeta[ref] = {
            lastActiveAt: rawEntry.lastActiveAt,
            expiresAt: rawEntry.expiresAt,
          };
        }
      }
      if (Object.keys(cleanedMeta).length > 0) {
        meta[chatId] = cleanedMeta;
      }
    }
  }

  return meta && Object.keys(meta).length > 0
    ? { version: STORE_VERSION, follows, meta }
    : { version: STORE_VERSION, follows };
}

function quarantineFile(filePath: string): void {
  const timestamp = Date.now();
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const target = path.join(dir, `${base}.corrupt.${timestamp}`);
  try {
    fs.renameSync(filePath, target);
  } catch {
    // If quarantine fails (e.g. permission), remove the corrupt file so we can start fresh.
    try {
      fs.unlinkSync(filePath);
    } catch {
      // ignore - best effort
    }
  }
}

export class FollowStore {
  private readonly filePath: string;
  private readonly maxPerChat: number;
  private readonly maxTotal: number;
  private readonly inactivityTtlMs: number;
  private readonly now: () => number;

  constructor(options: FollowStoreOptions) {
    const ttl = options.inactivityTtlMs ?? DEFAULT_INACTIVITY_TTL_MS;
    if (typeof ttl !== "number" || !Number.isFinite(ttl) || ttl <= 0) {
      throw new FollowStoreError("inactivityTtlMs must be a positive finite number");
    }
    this.filePath = options.filePath;
    this.maxPerChat =
      options.maxPerChat ?? options.maxFollowsPerChat ?? DEFAULT_MAX_PER_CHAT;
    this.maxTotal = options.maxTotal ?? options.maxTotalEntries ?? DEFAULT_MAX_TOTAL;
    this.inactivityTtlMs = ttl;
    this.now = options.now ?? Date.now;
  }

  private read(): StoreFile {
    if (!fs.existsSync(this.filePath)) {
      return emptyStore();
    }
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf8");
    } catch {
      quarantineFile(this.filePath);
      return emptyStore();
    }
    if (raw.trim() === "") {
      return emptyStore();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      quarantineFile(this.filePath);
      return emptyStore();
    }
    try {
      return validateStoreFile(parsed);
    } catch {
      quarantineFile(this.filePath);
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

  private totalCount(data: StoreFile): number {
    let total = 0;
    for (const list of Object.values(data.follows)) total += list.length;
    return total;
  }

  private isEntryExpired(data: StoreFile, chatId: string, ref: string, atMs: number): boolean {
    const entryMeta = data.meta?.[chatId]?.[ref];
    return entryMeta !== undefined && entryMeta.expiresAt <= atMs;
  }

  private pruneDataInPlace(data: StoreFile, atMs: number): number {
    let removed = 0;
    for (const [chatId, list] of Object.entries(data.follows)) {
      const kept: string[] = [];
      for (const ref of list) {
        if (this.isEntryExpired(data, chatId, ref, atMs)) {
          removed += 1;
          if (data.meta?.[chatId]) {
            delete data.meta[chatId][ref];
          }
        } else {
          kept.push(ref);
        }
      }
      if (kept.length === 0) {
        delete data.follows[chatId];
        if (data.meta) {
          delete data.meta[chatId];
        }
      } else {
        data.follows[chatId] = kept;
        if (data.meta?.[chatId] && Object.keys(data.meta[chatId]).length === 0) {
          delete data.meta[chatId];
        }
      }
    }
    if (data.meta && Object.keys(data.meta).length === 0) {
      delete data.meta;
    }
    return removed;
  }

  private setEntryMeta(data: StoreFile, chatId: string, ref: string, atMs: number): void {
    if (!data.meta) {
      data.meta = {};
    }
    if (!data.meta[chatId]) {
      data.meta[chatId] = {};
    }
    data.meta[chatId][ref] = {
      lastActiveAt: atMs,
      expiresAt: atMs + this.inactivityTtlMs,
    };
  }

  private deleteEntryMeta(data: StoreFile, chatId: string, ref: string): void {
    if (!data.meta?.[chatId]) return;
    delete data.meta[chatId][ref];
    if (Object.keys(data.meta[chatId]).length === 0) {
      delete data.meta[chatId];
    }
    if (Object.keys(data.meta).length === 0) {
      delete data.meta;
    }
  }

  follow(chatId: string, ref: string): boolean {
    if (typeof chatId !== "string" || chatId.length === 0) {
      throw new FollowStoreError("chatId must be a non-empty string");
    }
    if (parseRef(ref) === null) {
      throw new FollowStoreError(`invalid ref: ${ref}`);
    }
    const nowMs = this.now();
    const data = this.read();
    const pruned = this.pruneDataInPlace(data, nowMs);
    const existing = data.follows[chatId] ?? [];
    if (existing.includes(ref)) {
      if (pruned > 0) {
        this.write(data);
      }
      return false;
    }
    if (existing.length >= this.maxPerChat) {
      if (pruned > 0) {
        this.write(data);
      }
      throw new FollowStoreError(`per-chat follow limit reached (${this.maxPerChat})`);
    }
    if (this.totalCount(data) >= this.maxTotal) {
      if (pruned > 0) {
        this.write(data);
      }
      throw new FollowStoreError(`total follow limit reached (${this.maxTotal})`);
    }
    data.follows[chatId] = [...existing, ref];
    this.setEntryMeta(data, chatId, ref, nowMs);
    this.write(data);
    return true;
  }

  unfollow(chatId: string, ref: string): boolean {
    if (typeof chatId !== "string" || chatId.length === 0) {
      throw new FollowStoreError("chatId must be a non-empty string");
    }
    if (parseRef(ref) === null) {
      throw new FollowStoreError(`invalid ref: ${ref}`);
    }
    const nowMs = this.now();
    const data = this.read();
    const pruned = this.pruneDataInPlace(data, nowMs);
    const existing = data.follows[chatId];
    if (!existing || !existing.includes(ref)) {
      if (pruned > 0) {
        this.write(data);
      }
      return false;
    }
    const next = existing.filter((entry) => entry !== ref);
    if (next.length === 0) {
      delete data.follows[chatId];
    } else {
      data.follows[chatId] = next;
    }
    this.deleteEntryMeta(data, chatId, ref);
    this.write(data);
    return true;
  }

  list(chatId: string): string[] {
    if (typeof chatId !== "string" || chatId.length === 0) {
      throw new FollowStoreError("chatId must be a non-empty string");
    }
    const nowMs = this.now();
    const data = this.read();
    const raw = data.follows[chatId] ?? [];
    return raw.filter((ref) => !this.isEntryExpired(data, chatId, ref, nowMs));
  }

  followersOf(ref: string): string[] {
    if (parseRef(ref) === null) {
      throw new FollowStoreError(`invalid ref: ${ref}`);
    }
    const nowMs = this.now();
    const data = this.read();
    const result: string[] = [];
    for (const [chatId, list] of Object.entries(data.follows)) {
      if (list.includes(ref) && !this.isEntryExpired(data, chatId, ref, nowMs)) {
        result.push(chatId);
      }
    }
    return result;
  }

  /**
   * Return the persisted `{ lastActiveAt, expiresAt }` metadata for an active
   * `(chatId, ref)` follow, or `null` when absent or expired.
   */
  getFollowMetadata(chatId: string, ref: string): FollowEntryMetadata | null {
    if (typeof chatId !== "string" || chatId.length === 0) {
      throw new FollowStoreError("chatId must be a non-empty string");
    }
    if (parseRef(ref) === null) {
      throw new FollowStoreError(`invalid ref: ${ref}`);
    }
    const nowMs = this.now();
    const data = this.read();
    const list = data.follows[chatId];
    if (!list || !list.includes(ref) || this.isEntryExpired(data, chatId, ref, nowMs)) {
      return null;
    }
    const entryMeta = data.meta?.[chatId]?.[ref];
    return entryMeta ? { ...entryMeta } : null;
  }

  /**
   * Record market/squad activity for `ref`, extending `lastActiveAt` and
   * `expiresAt` for all non-expired subscribers while pruning expired entries.
   * Returns the number of active subscriptions refreshed.
   */
  recordActivity(ref: string, atMs: number = this.now()): number {
    if (parseRef(ref) === null) {
      throw new FollowStoreError(`invalid ref: ${ref}`);
    }
    if (typeof atMs !== "number" || !Number.isFinite(atMs)) {
      throw new FollowStoreError("activity timestamp must be a finite number");
    }
    const data = this.read();
    const pruned = this.pruneDataInPlace(data, atMs);
    let refreshed = 0;
    for (const [chatId, list] of Object.entries(data.follows)) {
      if (list.includes(ref)) {
        this.setEntryMeta(data, chatId, ref, atMs);
        refreshed += 1;
      }
    }
    if (pruned > 0 || refreshed > 0) {
      this.write(data);
    }
    return refreshed;
  }

  /**
   * Prune all expired follow entries from persisted storage without deleting
   * active subscriptions. Returns the number of expired entries removed.
   */
  pruneExpired(atMs: number = this.now()): number {
    if (typeof atMs !== "number" || !Number.isFinite(atMs)) {
      throw new FollowStoreError("prune timestamp must be a finite number");
    }
    const data = this.read();
    const removed = this.pruneDataInPlace(data, atMs);
    if (removed > 0) {
      this.write(data);
    }
    return removed;
  }
}

export function createFollowStore(options: FollowStoreOptions): FollowStore {
  return new FollowStore(options);
}
