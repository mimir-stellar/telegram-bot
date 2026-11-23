import * as fs from "fs";
import * as path from "path";
import { redactError, redactText } from "../redact.js";

export type RefKind = "market" | "squad";

export interface Ref {
  kind: RefKind;
  id: string;
}

/** Version 1 on-disk layout: no network identity. */
interface StoreFileV1 {
  version: 1;
  follows: Record<string, string[]>;
}

/** Version 2 on-disk layout: includes the Stellar network passphrase. */
interface StoreFileV2 {
  version: 2;
  network: string;
  follows: Record<string, string[]>;
}

/** Union of all recognised on-disk shapes. */
export type StoreFile = StoreFileV1 | StoreFileV2;

/** Current store version written by this code. */
export const STORE_VERSION = 2;

export const DEFAULT_MAX_PER_CHAT = 50;

/**
 * Maximum number of follows a single chat may hold. Enforced by `FollowStore.follow`
 * via `maxPerChat`; exposed here so command handlers can report the limit.
 */

export const DEFAULT_MAX_TOTAL = 5000;

export const DIGEST_INTERVAL_MIN_SECONDS = 60;

export const DIGEST_INTERVAL_MAX_SECONDS = 7 * 24 * 60 * 60;

/** Version of the portable chat export format. */
export const EXPORT_VERSION = 1;

/**
 * Portable, versioned snapshot of one chat's follows.
 *
 * Intentionally narrow: it carries only the chat id and its refs, never
 * another chat's data, so an import can verify the boundary is intact.
 */
export interface ChatExport {
  /** Must equal {@link EXPORT_VERSION}. */
  version: number;
  /** The chat id this snapshot belongs to. */
  chatId: string;
  /** The ordered list of ref strings (e.g. `"market:abc"`). */
  refs: string[];
}

export class FollowStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FollowStoreError";
  }
}

export interface ImportResult {
  added: number;
  skipped: number;
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
 * When `network` is supplied, the store records it in every new file (version 2)
 * and refuses to open an existing file that was written for a different network.
 * An existing version-1 file (no network) must be migrated explicitly via
 * {@link FollowStore.migrateToNetwork} before the network check can be enforced.
 */
export interface FollowStoreOptions {
  filePath: string;
  maxPerChat?: number;
  maxTotal?: number;
  // Aliases for API compatibility.
  maxFollowsPerChat?: number;
  maxTotalEntries?: number;
  /**
   * Stellar network passphrase (or any stable network identifier) that this
   * store is bound to. When set:
   * - new files are written at version 2 with this value
   * - existing version-2 files must carry the same value or the store throws
   * - existing version-1 files (no network field) trigger a `FollowStoreError`
   *   until `migrateToNetwork()` is called
   *
   * When absent, the store operates without network enforcement (backwards
   * compatible with callers that do not have a passphrase available).
   */
  network?: string | undefined;
  fs?: Partial<FollowStoreFs>;
  now?: () => number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Canonical unsigned integer: `0` or a sequence of 1–20 digits with no
 * leading zero, no sign prefix, no decimal point, and no exponent.
 *
 * The upper bound of 20 digits covers u64::MAX (18_446_744_073_709_551_615).
 */
const CANONICAL_UINT_RE = /^(0|[1-9]\d{0,19})$/;

/**
 * An id that "looks numeric" must be a canonical unsigned integer.
 *
 * "Looks numeric" is any id that:
 *   - starts with a digit, sign (`+`/`-`), decimal point, or `0x`/`0X`, OR
 *   - parses as a finite JavaScript number (catches exponent forms like `1e5`).
 *
 * Contract address strkeys (e.g. `CABC…`) and human-readable slugs that
 * contain no digit-like start characters pass through unchecked.
 */
function isCanonicalNumericId(id: string): boolean {
  const looksNumeric =
    /^[+\-0-9.]/.test(id) ||
    (id.length > 0 && Number.isFinite(Number(id)));
  if (!looksNumeric) return true;
  return CANONICAL_UINT_RE.test(id);
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
  // Reject non-canonical numeric ids: signed, exponent, leading-zero, or
  // oversized decimal strings are all rejected here.
  if (!isCanonicalNumericId(id)) return null;
  return { kind, id };
}

export function formatRef(kind: RefKind, id: string): string {
  return `${kind}:${id}`;
}

function emptyStore(network?: string): StoreFile {
  if (network !== undefined) {
    return { version: 2, network, follows: {} };
  }
  return { version: 1, follows: {} };
}

function normalizeRefList(chatId: string, list: unknown, context: string): string[] {
  if (!Array.isArray(list)) {
    throw new FollowStoreError(`${context}[${chatId}] is not an array`);
  }
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const entry of list) {
    if (typeof entry !== "string" || parseRef(entry) === null) {
      throw new FollowStoreError(`invalid ref in ${context}[${chatId}]`);
    }
    if (!seen.has(entry)) {
      seen.add(entry);
      cleaned.push(entry);
    }
  }
  return cleaned;
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
    follows[chatId] = normalizeRefList(chatId, list, "follows");
  }
  throw new FollowStoreError(`unsupported store version: ${String(version)}`);
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
  private readonly network: string | undefined;
  private readonly readFileSync: FollowStoreFs["readFileSync"];
  private readonly renameSync: FollowStoreFs["renameSync"];
  private readonly now: () => number;

  /**
   * Tail of the in-process serialization chain. Every mutating operation
   * (`follow`, `unfollow`) appends itself to this chain so that concurrent
   * calls on the same `FollowStore` instance execute one at a time and cannot
   * overwrite each other's read-modify-write cycle.
   */
  private _mutex: Promise<void> = Promise.resolve();

  constructor(options: FollowStoreOptions) {
    this.filePath = options.filePath;
    this.maxPerChat =
      options.maxPerChat ?? options.maxFollowsPerChat ?? DEFAULT_MAX_PER_CHAT;
    this.maxTotal = options.maxTotal ?? options.maxTotalEntries ?? DEFAULT_MAX_TOTAL;
    this.network = options.network;
    this.readFileSync =
      options.fs?.readFileSync ?? ((p, enc) => fs.readFileSync(p, enc));
    this.renameSync = options.fs?.renameSync ?? fs.renameSync;
    this.now = options.now ?? Date.now;
  }

  /**
   * Append `fn` to the serialization chain and return a Promise that resolves
   * (or rejects) with its result. Only one `fn` runs at a time per store
   * instance, so concurrent `follow`/`unfollow` calls do not race.
   */
  private _serialize<T>(fn: () => T): Promise<T> {
    const next = this._mutex.then(() => fn());
    // The chain must never stall on a rejection; swallow errors on the shared
    // tail so the next operation can always start.
    this._mutex = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private read(): StoreFile {
    if (!fs.existsSync(this.filePath)) {
      return emptyStore(this.network);
    }
    let raw: string;
    try {
      raw = this.readFileSync(this.filePath, "utf8");
    } catch (err) {
      quarantineFile(this.renameSync, this.now, this.filePath, redactError(err));
      return emptyStore(this.network);
    }
    if (raw.trim() === "") {
      return emptyStore(this.network);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      quarantineFile(this.renameSync, this.now, this.filePath, redactError(err));
      return emptyStore(this.network);
    }
    let data: StoreFile;
    try {
      data = validateStoreFile(parsed);
    } catch (err) {
      quarantineFile(this.renameSync, this.now, this.filePath, redactError(err));
      return emptyStore(this.network);
    }

    // ── Network enforcement ───────────────────────────────────────────────────
    if (this.network !== undefined) {
      if (data.version === 1) {
        // Version-1 files predate network identity. Refuse to use them until
        // the operator explicitly migrates via migrateToNetwork(). This prevents
        // a file created on mainnet from being silently reused on testnet after
        // the operator adds a STELLAR_NETWORK_PASSPHRASE.
        throw new FollowStoreError(
          `follow store at ${redactText(this.filePath)} has no network identity (version 1). ` +
            `Call migrateToNetwork() to bind it to the configured network before use, ` +
            `or delete the file to start fresh.`,
        );
      }
      if (data.version === 2 && data.network !== this.network) {
        throw new FollowStoreError(
          `follow store at ${redactText(this.filePath)} is bound to a different network. ` +
            `Delete the file or use a separate filePath for each network.`,
        );
      }
    }

    return data;
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

  /**
   * Add `ref` to `chatId`'s follow list.
   *
   * Argument validation is synchronous and throws `FollowStoreError` before
   * the returned Promise is created. The read-modify-write is serialized
   * through an in-process mutex so concurrent calls never overwrite each other.
   *
   * @returns A Promise that resolves to `true` when the ref was added, or
   *   `false` when it was already present (idempotent).
   */
  follow(chatId: string, ref: string): Promise<boolean> {
    if (typeof chatId !== "string" || chatId.length === 0) {
      throw new FollowStoreError("chatId must be a non-empty string");
    }
    if (parseRef(ref) === null) {
      throw new FollowStoreError(`invalid ref: ${ref}`);
    }
    return this._serialize(() => {
      const data = this.read();
      const existing = data.follows[chatId] ?? [];
      if (existing.includes(ref)) {
        return false;
      }
      if (existing.length >= this.maxPerChat) {
        throw new FollowStoreError(`per-chat follow limit reached (${this.maxPerChat})`);
      }
      if (this.totalCount(data) >= this.maxTotal) {
        throw new FollowStoreError(`total follow limit reached (${this.maxTotal})`);
      }
      data.follows[chatId] = [...existing, ref];
      this.write(data);
      return true;
    });
  }

  /**
   * Remove `ref` from `chatId`'s follow list.
   *
   * Argument validation is synchronous. The read-modify-write is serialized
   * through the same in-process mutex as `follow`.
   *
   * @returns A Promise that resolves to `true` when the ref was removed, or
   *   `false` when it was not present.
   */
  unfollow(chatId: string, ref: string): Promise<boolean> {
    if (typeof chatId !== "string" || chatId.length === 0) {
      throw new FollowStoreError("chatId must be a non-empty string");
    }
    if (parseRef(ref) === null) {
      throw new FollowStoreError(`invalid ref: ${ref}`);
    }
    return this._serialize(() => {
      const data = this.read();
      const existing = data.follows[chatId];
      if (!existing || !existing.includes(ref)) {
        return false;
      }
      const next = existing.filter((entry) => entry !== ref);
      if (next.length === 0) {
        delete data.follows[chatId];
      } else {
        data.follows[chatId] = next;
      }
      this.write(data);
      return true;
    });
  }

  /** Return a snapshot of `chatId`'s follow list. */
  list(chatId: string): Promise<string[]> {
    if (typeof chatId !== "string" || chatId.length === 0) {
      throw new FollowStoreError("chatId must be a non-empty string");
    }
    return Promise.resolve(this.read()).then((data) => [...(data.follows[chatId] ?? [])]);
  }

  /**
   * Import follows from a `StoreFile` or `chatId -> refs[]` map.
   * Duplicate references (within the import or already present in the store)
   * are normalized away before enforcing `maxPerChat` and `maxTotal` limits.
   */
  import(source: StoreFile | Record<string, readonly string[]>): ImportResult {
    if (!isPlainObject(source)) {
      throw new FollowStoreError("import payload must be an object");
    }
    let rawFollows: Record<string, unknown>;
    if ("version" in source && "follows" in source && typeof source.version === "number") {
      if (source.version !== STORE_VERSION) {
        throw new FollowStoreError(`unsupported store version: ${String(source.version)}`);
      }
      if (!isPlainObject(source.follows)) {
        throw new FollowStoreError("follows is not an object");
      }
      rawFollows = source.follows as Record<string, unknown>;
    } else {
      rawFollows = source as Record<string, unknown>;
    }

    const normalized = new Map<string, { rawCount: number; refs: string[] }>();
    for (const [chatId, list] of Object.entries(rawFollows)) {
      if (typeof chatId !== "string" || chatId.length === 0) {
        throw new FollowStoreError("chatId must be a non-empty string");
      }
      const refs = normalizeRefList(chatId, list, "import");
      normalized.set(chatId, { rawCount: (list as unknown[]).length, refs });
    }

    const data = this.read();
    let totalNew = 0;
    let skipped = 0;
    const pending: Array<{ chatId: string; toAdd: string[] }> = [];

    for (const [chatId, { rawCount, refs }] of normalized) {
      const existing = data.follows[chatId] ?? [];
      const existingSet = new Set(existing);
      const toAdd = refs.filter((ref) => !existingSet.has(ref));
      skipped += rawCount - toAdd.length;

      if (existing.length + toAdd.length > this.maxPerChat) {
        throw new FollowStoreError(`per-chat follow limit reached (${this.maxPerChat})`);
      }
      totalNew += toAdd.length;
      if (toAdd.length > 0) {
        pending.push({ chatId, toAdd });
      }
    }

    if (this.totalCount(data) + totalNew > this.maxTotal) {
      throw new FollowStoreError(`total follow limit reached (${this.maxTotal})`);
    }

    if (totalNew > 0) {
      for (const { chatId, toAdd } of pending) {
        data.follows[chatId] = [...(data.follows[chatId] ?? []), ...toAdd];
      }
      this.write(data);
    }

    return { added: totalNew, skipped };
  }

  followersOf(ref: string): string[] {
    if (parseRef(ref) === null) {
      throw new FollowStoreError(`invalid ref: ${ref}`);
    }
    return Promise.resolve(this.read()).then((data) => {
      const result: string[] = [];
      for (const [chatId, list] of Object.entries(data.follows)) {
        if (list.includes(ref)) result.push(chatId);
      }
      return result;
    });
  }

  /**
   * Export a versioned snapshot of one chat's follows.
   *
   * The returned object is JSON-serialisable and self-describing: it carries
   * the export version, the chat id, and the ordered ref list. No other chat's
   * data is included. Returns an export with an empty `refs` array when the
   * chat has no follows (not an error).
   */
  exportChat(chatId: string): ChatExport {
    if (typeof chatId !== "string" || chatId.length === 0) {
      throw new FollowStoreError("chatId must be a non-empty string");
    }
    const data = this.read();
    return {
      version: EXPORT_VERSION,
      chatId,
      refs: [...(data.follows[chatId] ?? [])],
    };
  }

  /**
   * Restore one chat's follows from a portable export.
   *
   * Chat-boundary enforcement: the export's `chatId` must equal the supplied
   * `chatId`; importing a snapshot that belongs to a different chat is refused
   * to prevent accidental cross-chat contamination.
   *
   * Quota enforcement: the ref count in the export must not exceed
   * `maxPerChat`, and adding them must not push the store past `maxTotal`.
   * Both checks are done atomically before writing, so a quota violation
   * leaves the existing data unchanged.
   *
   * The import **replaces** the target chat's current follows with the
   * snapshot's refs (a restore, not a merge). All other chats are untouched.
   *
   * @param chatId - The chat whose follows will be replaced.
   * @param exported - A `ChatExport` returned by {@link exportChat}.
   * @returns The number of refs restored.
   */
  importChat(chatId: string, exported: unknown): number {
    if (typeof chatId !== "string" || chatId.length === 0) {
      throw new FollowStoreError("chatId must be a non-empty string");
    }

    // ── Validate the export object ────────────────────────────────────────────
    if (
      exported === null ||
      typeof exported !== "object" ||
      Array.isArray(exported)
    ) {
      throw new FollowStoreError("exported data must be a plain object");
    }
    const exp = exported as Record<string, unknown>;

    if (exp.version !== EXPORT_VERSION) {
      throw new FollowStoreError(
        `unsupported export version: ${String(exp.version)}; expected ${EXPORT_VERSION}`,
      );
    }

    if (typeof exp.chatId !== "string" || exp.chatId.length === 0) {
      throw new FollowStoreError("exported data is missing a valid chatId");
    }

    // ── Chat-boundary check ───────────────────────────────────────────────────
    if (exp.chatId !== chatId) {
      throw new FollowStoreError(
        `export belongs to chat ${exp.chatId} but import target is chat ${chatId}; ` +
          `importing across chat boundaries is not allowed`,
      );
    }

    if (!Array.isArray(exp.refs)) {
      throw new FollowStoreError("exported data is missing a refs array");
    }

    // Validate every ref before touching the store.
    const refs: string[] = [];
    for (const entry of exp.refs) {
      if (typeof entry !== "string" || parseRef(entry) === null) {
        throw new FollowStoreError(`exported data contains an invalid ref: ${String(entry)}`);
      }
      // Deduplicate silently — an export with accidental duplicates restores cleanly.
      if (!refs.includes(entry)) {
        refs.push(entry);
      }
    }

    // ── Quota checks (atomic: fail before any write) ──────────────────────────
    if (refs.length > this.maxPerChat) {
      throw new FollowStoreError(
        `import would exceed the per-chat follow limit (${refs.length} > ${this.maxPerChat})`,
      );
    }

    const data = this.read();
    const currentForChat = data.follows[chatId]?.length ?? 0;
    const otherTotal = this.totalCount(data) - currentForChat;
    if (otherTotal + refs.length > this.maxTotal) {
      throw new FollowStoreError(
        `import would exceed the total follow limit (${otherTotal + refs.length} > ${this.maxTotal})`,
      );
    }

    // ── Atomic replace ────────────────────────────────────────────────────────
    if (refs.length === 0) {
      delete data.follows[chatId];
    } else {
      data.follows[chatId] = refs;
    }
    this.write(data);
    return refs.length;
  }
}

export function createFollowStore(options: FollowStoreOptions): FollowStore {
  return new FollowStore(options);
}