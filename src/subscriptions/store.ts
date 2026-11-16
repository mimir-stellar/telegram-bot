import * as fs from "fs";
import * as path from "path";

export type RefKind = "market" | "squad";

export interface Ref {
  kind: RefKind;
  id: string;
}

export interface StoreFile {
  version: number;
  // chatId -> array of ref strings (e.g. "market:123")
  follows: Record<string, string[]>;
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

export interface FollowStoreOptions {
  filePath: string;
  maxPerChat?: number;
  maxTotal?: number;
  // Aliases for API compatibility.
  maxFollowsPerChat?: number;
  maxTotalEntries?: number;
}

export interface ImportOptions {
  /** Replace existing subscriptions instead of merging with them. */
  replace?: boolean;
}

export interface FollowImportResult {
  added: number;
  duplicatesSkipped: number;
  totalForChat: number;
}

export interface StoreImportResult {
  added: number;
  duplicatesSkipped: number;
  totalEntries: number;
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

/**
 * Validate and deduplicate a list of follow references in first-seen order.
 * Throws FollowStoreError if the input is not an array or contains any invalid ref.
 */
export function deduplicateFollowRefs(refs: readonly unknown[], context = "import"): string[] {
  if (!Array.isArray(refs)) {
    throw new FollowStoreError(`${context} must be an array`);
  }
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const entry of refs) {
    if (typeof entry !== "string") {
      throw new FollowStoreError(`invalid ref in ${context}`);
    }
    const parsed = parseRef(entry);
    if (parsed === null) {
      throw new FollowStoreError(`invalid ref in ${context}: ${entry}`);
    }
    const canonical = formatRef(parsed.kind, parsed.id);
    if (!seen.has(canonical)) {
      seen.add(canonical);
      unique.push(canonical);
    }
  }
  return unique;
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
    const cleaned = deduplicateFollowRefs(list, `follows[${chatId}]`);
    if (cleaned.length > 0) {
      follows[chatId] = cleaned;
    }
  }
  return { version: STORE_VERSION, follows };
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

  constructor(options: FollowStoreOptions) {
    this.filePath = options.filePath;
    this.maxPerChat =
      options.maxPerChat ?? options.maxFollowsPerChat ?? DEFAULT_MAX_PER_CHAT;
    this.maxTotal = options.maxTotal ?? options.maxTotalEntries ?? DEFAULT_MAX_TOTAL;
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

  follow(chatId: string, ref: string): boolean {
    if (typeof chatId !== "string" || chatId.length === 0) {
      throw new FollowStoreError("chatId must be a non-empty string");
    }
    if (parseRef(ref) === null) {
      throw new FollowStoreError(`invalid ref: ${ref}`);
    }
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
  }

  unfollow(chatId: string, ref: string): boolean {
    if (typeof chatId !== "string" || chatId.length === 0) {
      throw new FollowStoreError("chatId must be a non-empty string");
    }
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
    } else {
      data.follows[chatId] = next;
    }
    this.write(data);
    return true;
  }

  list(chatId: string): string[] {
    if (typeof chatId !== "string" || chatId.length === 0) {
      throw new FollowStoreError("chatId must be a non-empty string");
    }
    const data = this.read();
    return [...(data.follows[chatId] ?? [])];
  }

  followersOf(ref: string): string[] {
    if (parseRef(ref) === null) {
      throw new FollowStoreError(`invalid ref: ${ref}`);
    }
    const data = this.read();
    const result: string[] = [];
    for (const [chatId, list] of Object.entries(data.follows)) {
      if (list.includes(ref)) result.push(chatId);
    }
    return result;
  }

  /**
   * Import a batch of follow references for a single chat, normalizing and
   * deduplicating both within the batch and against existing entries before
   * checking per-chat and global subscription limits.
   */
  importFollows(
    chatId: string,
    refs: readonly string[],
    options: ImportOptions = {},
  ): FollowImportResult {
    if (typeof chatId !== "string" || chatId.length === 0) {
      throw new FollowStoreError("chatId must be a non-empty string");
    }
    if (!Array.isArray(refs)) {
      throw new FollowStoreError("refs must be an array");
    }
    const incomingUnique = deduplicateFollowRefs(refs, `importFollows(${chatId})`);
    const data = this.read();
    const existing = data.follows[chatId] ?? [];
    const base = options.replace === true ? [] : existing;

    const mergedSet = new Set<string>(base);
    const merged = [...base];
    let added = 0;
    for (const ref of incomingUnique) {
      if (!mergedSet.has(ref)) {
        mergedSet.add(ref);
        merged.push(ref);
        added += 1;
      }
    }
    const duplicatesSkipped = refs.length - added;

    if (merged.length > this.maxPerChat) {
      throw new FollowStoreError(`per-chat follow limit reached (${this.maxPerChat})`);
    }
    const otherTotal = this.totalCount(data) - existing.length;
    if (otherTotal + merged.length > this.maxTotal) {
      throw new FollowStoreError(`total follow limit reached (${this.maxTotal})`);
    }

    if (merged.length === 0) {
      delete data.follows[chatId];
    } else {
      data.follows[chatId] = merged;
    }
    this.write(data);

    return {
      added,
      duplicatesSkipped,
      totalForChat: merged.length,
    };
  }

  /**
   * Import follow references across multiple chats atomically, deduplicating
   * each chat's entries before enforcing per-chat and global limits.
   */
  importStore(
    followsByChat: Record<string, readonly string[]>,
    options: ImportOptions = {},
  ): StoreImportResult {
    if (!isPlainObject(followsByChat)) {
      throw new FollowStoreError("followsByChat must be an object");
    }
    const data = options.replace === true ? emptyStore() : this.read();
    const nextFollows: Record<string, string[]> = {};
    for (const [chatId, list] of Object.entries(data.follows)) {
      nextFollows[chatId] = [...list];
    }

    let added = 0;
    let duplicatesSkipped = 0;

    for (const [chatId, rawList] of Object.entries(followsByChat)) {
      if (typeof chatId !== "string" || chatId.length === 0) {
        throw new FollowStoreError("chatId must be a non-empty string");
      }
      if (!Array.isArray(rawList)) {
        throw new FollowStoreError(`follows[${chatId}] must be an array`);
      }
      const incomingUnique = deduplicateFollowRefs(rawList, `follows[${chatId}]`);
      const base = nextFollows[chatId] ?? [];
      const mergedSet = new Set<string>(base);
      const merged = [...base];
      let chatAdded = 0;
      for (const ref of incomingUnique) {
        if (!mergedSet.has(ref)) {
          mergedSet.add(ref);
          merged.push(ref);
          chatAdded += 1;
        }
      }
      if (merged.length > this.maxPerChat) {
        throw new FollowStoreError(`per-chat follow limit reached (${this.maxPerChat})`);
      }
      added += chatAdded;
      duplicatesSkipped += rawList.length - chatAdded;
      if (merged.length > 0) {
        nextFollows[chatId] = merged;
      } else {
        delete nextFollows[chatId];
      }
    }

    let totalEntries = 0;
    for (const list of Object.values(nextFollows)) {
      totalEntries += list.length;
    }
    if (totalEntries > this.maxTotal) {
      throw new FollowStoreError(`total follow limit reached (${this.maxTotal})`);
    }

    this.write({ version: STORE_VERSION, follows: nextFollows });
    return {
      added,
      duplicatesSkipped,
      totalEntries,
    };
  }
}

export function createFollowStore(options: FollowStoreOptions): FollowStore {
  return new FollowStore(options);
}
