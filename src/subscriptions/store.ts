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
  /**
   * Optional hook invoked between reading current state and committing the
   * next snapshot in async mutations (useful for deterministic race tests).
   */
  onBeforeCommit?: () => Promise<void> | void;
}

interface PathLockState {
  tail: Promise<void>;
  pending: number;
  syncActive: boolean;
  generation: number;
}

const pathLocks = new Map<string, PathLockState>();
let tmpFileCounter = 0;

function canonicalStoreKey(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function getPathLock(key: string): PathLockState {
  let state = pathLocks.get(key);
  if (!state) {
    state = {
      tail: Promise.resolve(),
      pending: 0,
      syncActive: false,
      generation: 0,
    };
    pathLocks.set(key, state);
  }
  return state;
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
  private readonly lockKey: string;
  private readonly maxPerChat: number;
  private readonly maxTotal: number;
  private readonly onBeforeCommit: (() => Promise<void> | void) | undefined;

  constructor(options: FollowStoreOptions) {
    this.filePath = options.filePath;
    this.lockKey = canonicalStoreKey(options.filePath);
    this.maxPerChat =
      options.maxPerChat ?? options.maxFollowsPerChat ?? DEFAULT_MAX_PER_CHAT;
    this.maxTotal = options.maxTotal ?? options.maxTotalEntries ?? DEFAULT_MAX_TOTAL;
    this.onBeforeCommit = options.onBeforeCommit;
  }

  pendingMutations(): number {
    return getPathLock(this.lockKey).pending;
  }

  /**
   * Serialize asynchronous work against all FollowStore instances targeting
   * the same resolved store file path within this process.
   */
  runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const lock = getPathLock(this.lockKey);
    lock.pending += 1;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prev = lock.tail;
    lock.tail = prev.then(() => gate);

    return prev.then(async () => {
      try {
        return await fn();
      } finally {
        lock.pending -= 1;
        release();
        if (lock.pending === 0 && !lock.syncActive) {
          lock.tail = Promise.resolve();
        }
      }
    });
  }

  private runSyncMutation<T>(fn: () => T): T {
    const lock = getPathLock(this.lockKey);
    if (lock.syncActive) {
      throw new FollowStoreError("re-entrant synchronous follow-store mutation rejected");
    }
    lock.syncActive = true;
    try {
      const result = fn();
      lock.generation += 1;
      return result;
    } finally {
      lock.syncActive = false;
    }
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

  private async readAsync(): Promise<StoreFile> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        return emptyStore();
      }
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
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.${++tmpFileCounter}.tmp`;
    const payload = JSON.stringify(data, null, 2) + "\n";
    fs.writeFileSync(tmp, payload, "utf8");
    fs.renameSync(tmp, this.filePath);
  }

  private async writeAsync(data: StoreFile): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.promises.mkdir(dir, { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.${++tmpFileCounter}.tmp`;
    const payload = JSON.stringify(data, null, 2) + "\n";
    await fs.promises.writeFile(tmp, payload, "utf8");
    await fs.promises.rename(tmp, this.filePath);
  }

  private totalCount(data: StoreFile): number {
    let total = 0;
    for (const list of Object.values(data.follows)) total += list.length;
    return total;
  }

  private applyFollow(data: StoreFile, chatId: string, ref: string): boolean {
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
    return true;
  }

  private applyUnfollow(data: StoreFile, chatId: string, ref: string): boolean {
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
    return true;
  }

  follow(chatId: string, ref: string): boolean {
    if (typeof chatId !== "string" || chatId.length === 0) {
      throw new FollowStoreError("chatId must be a non-empty string");
    }
    if (parseRef(ref) === null) {
      throw new FollowStoreError(`invalid ref: ${ref}`);
    }
    return this.runSyncMutation(() => {
      const data = this.read();
      if (!this.applyFollow(data, chatId, ref)) {
        return false;
      }
      this.write(data);
      return true;
    });
  }

  unfollow(chatId: string, ref: string): boolean {
    if (typeof chatId !== "string" || chatId.length === 0) {
      throw new FollowStoreError("chatId must be a non-empty string");
    }
    if (parseRef(ref) === null) {
      throw new FollowStoreError(`invalid ref: ${ref}`);
    }
    return this.runSyncMutation(() => {
      const data = this.read();
      if (!this.applyUnfollow(data, chatId, ref)) {
        return false;
      }
      this.write(data);
      return true;
    });
  }

  /**
   * Serialized asynchronous follow mutation. Overlapping followAsync and
   * unfollowAsync calls targeting the same store file execute in strict FIFO
   * order without overwriting one another.
   */
  followAsync(chatId: string, ref: string): Promise<boolean> {
    return this.runExclusive(async () => {
      if (typeof chatId !== "string" || chatId.length === 0) {
        throw new FollowStoreError("chatId must be a non-empty string");
      }
      if (parseRef(ref) === null) {
        throw new FollowStoreError(`invalid ref: ${ref}`);
      }
      const lock = getPathLock(this.lockKey);
      for (;;) {
        const genBefore = lock.generation;
        const data = await this.readAsync();
        const changed = this.applyFollow(data, chatId, ref);
        if (!changed) {
          return false;
        }
        if (this.onBeforeCommit) {
          await this.onBeforeCommit();
        }
        if (lock.generation !== genBefore) {
          continue;
        }
        await this.writeAsync(data);
        lock.generation += 1;
        return true;
      }
    });
  }

  /**
   * Serialized asynchronous unfollow mutation. Overlapping followAsync and
   * unfollowAsync calls targeting the same store file execute in strict FIFO
   * order without overwriting one another.
   */
  unfollowAsync(chatId: string, ref: string): Promise<boolean> {
    return this.runExclusive(async () => {
      if (typeof chatId !== "string" || chatId.length === 0) {
        throw new FollowStoreError("chatId must be a non-empty string");
      }
      if (parseRef(ref) === null) {
        throw new FollowStoreError(`invalid ref: ${ref}`);
      }
      const lock = getPathLock(this.lockKey);
      for (;;) {
        const genBefore = lock.generation;
        const data = await this.readAsync();
        const changed = this.applyUnfollow(data, chatId, ref);
        if (!changed) {
          return false;
        }
        if (this.onBeforeCommit) {
          await this.onBeforeCommit();
        }
        if (lock.generation !== genBefore) {
          continue;
        }
        await this.writeAsync(data);
        lock.generation += 1;
        return true;
      }
    });
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
}

export function createFollowStore(options: FollowStoreOptions): FollowStore {
  return new FollowStore(options);
}
