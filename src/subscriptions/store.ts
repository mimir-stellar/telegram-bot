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

export const CHAT_FOLLOW_EXPORT_VERSION = 1;

export interface ChatFollowExport {
  version: number;
  follows: string[];
}

export type ChatRestoreMode = "replace" | "merge";

export interface ChatRestoreOptions {
  /**
   * "replace" (default) replaces only the target chat's follows with the
   * validated export; "merge" appends missing entries onto the target chat.
   */
  mode?: ChatRestoreMode;
}

export interface ChatRestoreResult {
  restored: number;
  added: number;
  removed: number;
  follows: string[];
}

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

const FORBIDDEN_CHAT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function assertValidChatId(chatId: string): void {
  if (typeof chatId !== "string" || chatId.length === 0 || FORBIDDEN_CHAT_KEYS.has(chatId)) {
    throw new FollowStoreError("chatId must be a non-empty string");
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate and normalize a portable single-chat follow export payload (either
 * parsed object or raw JSON text). Rejects unknown versions, multi-chat store
 * maps, unexpected top-level keys, and any malformed follow reference.
 */
export function parseChatExport(input: unknown): ChatFollowExport {
  let rawObj: unknown = input;
  if (typeof input === "string") {
    try {
      rawObj = JSON.parse(input);
    } catch {
      throw new FollowStoreError("chat export is not valid JSON");
    }
  }
  if (!isPlainObject(rawObj)) {
    throw new FollowStoreError("chat export payload must be an object");
  }
  for (const key of Object.keys(rawObj)) {
    if (key !== "version" && key !== "follows") {
      throw new FollowStoreError(`unexpected field in chat export: ${key}`);
    }
  }
  if (rawObj.version !== CHAT_FOLLOW_EXPORT_VERSION) {
    throw new FollowStoreError(`unsupported chat export version: ${String(rawObj.version)}`);
  }
  if (!Array.isArray(rawObj.follows)) {
    throw new FollowStoreError("chat export follows must be an array of references");
  }
  const seen = new Set<string>();
  const validated: string[] = [];
  for (const entry of rawObj.follows) {
    if (typeof entry !== "string") {
      throw new FollowStoreError("invalid ref in chat export: non-string entry");
    }
    const parsed = parseRef(entry);
    if (parsed === null) {
      throw new FollowStoreError(`invalid ref in chat export: ${entry}`);
    }
    const canonical = formatRef(parsed.kind, parsed.id);
    if (!seen.has(canonical)) {
      seen.add(canonical);
      validated.push(canonical);
    }
  }
  return {
    version: CHAT_FOLLOW_EXPORT_VERSION,
    follows: validated,
  };
}

export function serializeChatExport(payload: ChatFollowExport): string {
  const validated = parseChatExport(payload);
  return JSON.stringify(validated, null, 2) + "\n";
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
   * Export a portable, versioned snapshot of a single chat's subscriptions
   * without exposing any other chat's identifiers or follows.
   */
  exportChat(chatId: string): ChatFollowExport {
    assertValidChatId(chatId);
    const data = this.read();
    return {
      version: CHAT_FOLLOW_EXPORT_VERSION,
      follows: [...(data.follows[chatId] ?? [])],
    };
  }

  /**
   * Atomically restore a single chat's subscriptions from a versioned portable
   * export, validating every reference upfront, preserving all other chats,
   * and enforcing per-chat and global quotas before writing to disk.
   */
  restoreChat(
    chatId: string,
    payload: unknown,
    options: ChatRestoreOptions = {},
  ): ChatRestoreResult {
    assertValidChatId(chatId);
    const mode: ChatRestoreMode = options.mode ?? "replace";
    if (mode !== "replace" && mode !== "merge") {
      throw new FollowStoreError(`invalid restore mode: ${String(mode)}`);
    }
    const exported = parseChatExport(payload);
    const data = this.read();
    const existing = data.follows[chatId] ?? [];

    let nextForChat: string[];
    if (mode === "merge") {
      const seen = new Set<string>(existing);
      nextForChat = [...existing];
      for (const ref of exported.follows) {
        if (!seen.has(ref)) {
          seen.add(ref);
          nextForChat.push(ref);
        }
      }
    } else {
      nextForChat = [...exported.follows];
    }

    if (nextForChat.length > this.maxPerChat) {
      throw new FollowStoreError(`per-chat follow limit reached (${this.maxPerChat})`);
    }
    const otherChatsTotal = this.totalCount(data) - existing.length;
    if (otherChatsTotal + nextForChat.length > this.maxTotal) {
      throw new FollowStoreError(`total follow limit reached (${this.maxTotal})`);
    }

    const existingSet = new Set<string>(existing);
    const nextSet = new Set<string>(nextForChat);
    let added = 0;
    for (const ref of nextForChat) {
      if (!existingSet.has(ref)) added += 1;
    }
    let removed = 0;
    for (const ref of existing) {
      if (!nextSet.has(ref)) removed += 1;
    }

    if (nextForChat.length === 0) {
      delete data.follows[chatId];
    } else {
      data.follows[chatId] = nextForChat;
    }
    this.write(data);

    return {
      restored: nextForChat.length,
      added,
      removed,
      follows: [...nextForChat],
    };
  }
}

export function createFollowStore(options: FollowStoreOptions): FollowStore {
  return new FollowStore(options);
}
