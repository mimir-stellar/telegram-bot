import * as fs from "fs";
import * as path from "path";

import { redactError, redactText } from "../redact.js";

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

export class FollowStoreQuarantineError extends FollowStoreError {
  readonly sourcePath: string;
  readonly quarantinePath: string;
  readonly causeDetail: string;

  constructor(params: {
    sourcePath: string;
    quarantinePath: string;
    causeDetail: string;
    secrets?: readonly string[] | undefined;
  }) {
    const opts = params.secrets ? { secrets: params.secrets, maxLen: 360 } : { maxLen: 360 };
    const safeSource = redactText(params.sourcePath, opts);
    const safeTarget = redactText(params.quarantinePath, opts);
    const safeCause = redactText(params.causeDetail, opts);
    super(
      `failed to quarantine unreadable follow store "${safeSource}" to "${safeTarget}" (${safeCause}); ` +
        `source file preserved intact — verify directory write permissions or move the file aside manually before retrying`,
    );
    this.name = "FollowStoreQuarantineError";
    this.sourcePath = safeSource;
    this.quarantinePath = safeTarget;
    this.causeDetail = safeCause;
  }
}

export interface FollowStoreFsOps {
  existsSync?: (p: string) => boolean;
  readFileSync?: (p: string, encoding: BufferEncoding) => string;
  writeFileSync?: (p: string, data: string, encoding: BufferEncoding) => void;
  renameSync?: (oldPath: string, newPath: string) => void;
  mkdirSync?: (p: string, options: { recursive: boolean }) => unknown;
  unlinkSync?: (p: string) => void;
}

export interface FollowStoreOptions {
  filePath: string;
  maxPerChat?: number;
  maxTotal?: number;
  // Aliases for API compatibility.
  maxFollowsPerChat?: number;
  maxTotalEntries?: number;
  /** Additional secret strings to scrub from error messages and logs. */
  secrets?: readonly string[];
  /** Optional filesystem overrides for deterministic fault-injection testing. */
  fsOps?: FollowStoreFsOps;
  /** Optional callback receiving redacted quarantine errors (defaults to console.error). */
  onQuarantineError?: (err: FollowStoreQuarantineError) => void;
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

function quarantineFile(
  filePath: string,
  fsOps?: FollowStoreFsOps,
  secrets?: readonly string[],
  onQuarantineError?: (err: FollowStoreQuarantineError) => void,
): void {
  const timestamp = Date.now();
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const target = path.join(dir, `${base}.corrupt.${timestamp}`);
  const rename = fsOps?.renameSync ?? fs.renameSync;
  try {
    rename(filePath, target);
  } catch (renameErr) {
    // Never unlink a source file that could not be quarantined: retain its
    // exact bytes on disk for operator forensics/recovery and surface a
    // redacted, actionable error so subsequent writes cannot overwrite it.
    const redactOpts = secrets ? { secrets, maxLen: 480 } : { maxLen: 480 };
    const err = new FollowStoreQuarantineError({
      sourcePath: filePath,
      quarantinePath: target,
      causeDetail: redactError(renameErr, redactOpts),
      secrets,
    });
    if (onQuarantineError) {
      onQuarantineError(err);
    } else {
      console.error(`[follow-store] ${err.message}`);
    }
    throw err;
  }
}

export class FollowStore {
  private readonly filePath: string;
  private readonly maxPerChat: number;
  private readonly maxTotal: number;
  private readonly secrets: readonly string[] | undefined;
  private readonly fsOps: FollowStoreFsOps | undefined;
  private readonly onQuarantineError: ((err: FollowStoreQuarantineError) => void) | undefined;

  constructor(options: FollowStoreOptions) {
    this.filePath = options.filePath;
    this.maxPerChat =
      options.maxPerChat ?? options.maxFollowsPerChat ?? DEFAULT_MAX_PER_CHAT;
    this.maxTotal = options.maxTotal ?? options.maxTotalEntries ?? DEFAULT_MAX_TOTAL;
    this.secrets = options.secrets;
    this.fsOps = options.fsOps;
    this.onQuarantineError = options.onQuarantineError;
  }

  private quarantine(): void {
    quarantineFile(this.filePath, this.fsOps, this.secrets, this.onQuarantineError);
  }

  private read(): StoreFile {
    const exists = this.fsOps?.existsSync ?? fs.existsSync;
    const readFile = this.fsOps?.readFileSync ?? fs.readFileSync;
    if (!exists(this.filePath)) {
      return emptyStore();
    }
    let raw: string;
    try {
      raw = readFile(this.filePath, "utf8");
    } catch {
      this.quarantine();
      return emptyStore();
    }
    if (raw.trim() === "") {
      return emptyStore();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.quarantine();
      return emptyStore();
    }
    try {
      return validateStoreFile(parsed);
    } catch {
      this.quarantine();
      return emptyStore();
    }
  }

  private write(data: StoreFile): void {
    const mkdir = this.fsOps?.mkdirSync ?? fs.mkdirSync;
    const writeFile = this.fsOps?.writeFileSync ?? fs.writeFileSync;
    const rename = this.fsOps?.renameSync ?? fs.renameSync;
    const dir = path.dirname(this.filePath);
    mkdir(dir, { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const payload = JSON.stringify(data, null, 2) + "\n";
    writeFile(tmp, payload, "utf8");
    rename(tmp, this.filePath);
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
}

export function createFollowStore(options: FollowStoreOptions): FollowStore {
  return new FollowStore(options);
}
