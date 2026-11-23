/**
 * Bounded, persisted checkpoint for scheduled digests.
 *
 * Stores pending decoded events and the timestamp of the last completed digest
 * run (`lastRunMs`) in a single versioned JSON file, written atomically via
 * temp-file + rename. Implements {@link LastRunStore} so it plugs directly into
 * {@link createScheduler}.
 *
 * Restart semantics:
 * - On startup, `load()` restores `lastRunMs` and any buffered `pending` events
 *   (trimmed to `maxPending` if the configured cap shrank between runs).
 * - A missing file is a clean cold start (`lastRunMs: null`, `pending: []`).
 * - A corrupt or incompatible file is quarantined beside the live path
 *   (`*.corrupt.<timestamp>`) and treated as a clean cold start so a bad file
 *   never wedges the poller.
 * - `createScheduler` checks `lastRunMs` on `start()`: if a scheduled boundary
 *   was missed while the process was down, it fires once to flush the restored
 *   pending events; otherwise it waits for the next boundary.
 * - Delivery is at-least-once / best-effort (never claiming exactly-once):
 *   pending events are cleared only after the Telegram send succeeds.
 */

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { DecodedEvent } from "../stellar/decode.js";
import type { LastRunStore } from "./schedule.js";

export const DIGEST_CHECKPOINT_VERSION = 1;
export const DEFAULT_DIGEST_MAX_PENDING = 200;

export interface DigestCheckpointStats {
  pending: number;
  dropped: number;
  lastRunMs: number | null;
  maxPending: number;
}

export interface DigestCheckpointOptions {
  /** Path to the checkpoint JSON file. `null` keeps state in-memory only. */
  filePath: string | null;
  /** Maximum number of pending events retained between scheduled runs. */
  maxPending?: number;
  /** Clock for quarantine timestamps and temp file names. */
  now?: () => number;
}

export interface DigestCheckpoint extends LastRunStore {
  load(): Promise<void>;
  enqueue(event: DecodedEvent): boolean;
  snapshotPending(): DecodedEvent[];
  acknowledgeSent(eventIds: ReadonlySet<string>): Promise<void>;
  flush(): Promise<boolean>;
  stats(): DigestCheckpointStats;
}

interface SerializedCheckpoint {
  version: typeof DIGEST_CHECKPOINT_VERSION;
  lastRunMs: number | null;
  pending: DecodedEvent[];
  dropped: number;
}

function bigintReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") {
    return { __bigint__: value.toString() };
  }
  return value;
}

function bigintReviver(_key: string, value: unknown): unknown {
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (
      keys.length === 1 &&
      keys[0] === "__bigint__" &&
      typeof record.__bigint__ === "string" &&
      /^-?\d+$/.test(record.__bigint__)
    ) {
      return BigInt(record.__bigint__);
    }
  }
  return value;
}

function isDecodedEventLike(value: unknown): value is DecodedEvent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const e = value as Record<string, unknown>;
  return (
    (e.source === "market" || e.source === "squad") &&
    typeof e.ledger === "number" &&
    Number.isFinite(e.ledger) &&
    typeof e.eventId === "string" &&
    e.payload !== null &&
    typeof e.payload === "object" &&
    typeof (e.payload as Record<string, unknown>).name === "string"
  );
}

function parseCheckpoint(raw: string): SerializedCheckpoint | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw, bigintReviver);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== DIGEST_CHECKPOINT_VERSION) {
    return null;
  }
  const lastRunMs = obj.lastRunMs;
  if (lastRunMs !== null && (typeof lastRunMs !== "number" || !Number.isFinite(lastRunMs))) {
    return null;
  }
  if (!Array.isArray(obj.pending) || !obj.pending.every(isDecodedEventLike)) {
    return null;
  }
  const dropped =
    typeof obj.dropped === "number" && Number.isInteger(obj.dropped) && obj.dropped >= 0
      ? obj.dropped
      : 0;
  return {
    version: DIGEST_CHECKPOINT_VERSION,
    lastRunMs,
    pending: obj.pending,
    dropped,
  };
}

export function createDigestCheckpoint(options: DigestCheckpointOptions): DigestCheckpoint {
  const maxPending = Math.max(1, Math.floor(options.maxPending ?? DEFAULT_DIGEST_MAX_PENDING));
  const filePath = options.filePath;
  const now = options.now ?? Date.now;

  let lastRunMs: number | null = null;
  let pending: DecodedEvent[] = [];
  let pendingIds = new Set<string>();
  let dropped = 0;
  let dirty = false;

  async function writeToDisk(): Promise<boolean> {
    if (!filePath) {
      dirty = false;
      return true;
    }
    const payload: SerializedCheckpoint = {
      version: DIGEST_CHECKPOINT_VERSION,
      lastRunMs,
      pending,
      dropped,
    };
    const serialized = JSON.stringify(payload, bigintReplacer, 2) + "\n";
    const tmpPath = `${filePath}.tmp.${process.pid}.${now()}`;
    try {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(tmpPath, serialized, "utf8");
      await rename(tmpPath, filePath);
      dirty = false;
      return true;
    } catch (err) {
      await unlink(tmpPath).catch(() => {});
      console.error(
        `[digest] failed to persist checkpoint to ${filePath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return false;
    }
  }

  async function quarantineCorruptFile(): Promise<void> {
    if (!filePath) return;
    const corruptPath = `${filePath}.corrupt.${now()}`;
    try {
      await rename(filePath, corruptPath);
      console.warn(`[digest] quarantined corrupt checkpoint to ${corruptPath}`);
    } catch {
      // Best-effort quarantine; never block startup.
    }
  }

  return {
    async load(): Promise<void> {
      lastRunMs = null;
      pending = [];
      pendingIds = new Set<string>();
      dropped = 0;
      dirty = false;

      if (!filePath) return;

      let raw: string;
      try {
        raw = await readFile(filePath, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return;
        console.warn(
          `[digest] could not read checkpoint ${filePath}: ${
            err instanceof Error ? err.message : String(err)
          }; starting clean`,
        );
        return;
      }

      const parsed = parseCheckpoint(raw);
      if (!parsed) {
        console.warn(`[digest] invalid checkpoint schema in ${filePath}; starting clean`);
        await quarantineCorruptFile();
        return;
      }

      lastRunMs = parsed.lastRunMs;
      dropped = parsed.dropped;

      // Enforce current maxPending bound, keeping the newest events.
      const overflow = Math.max(0, parsed.pending.length - maxPending);
      const kept = overflow > 0 ? parsed.pending.slice(overflow) : parsed.pending;
      if (overflow > 0) {
        dropped += overflow;
        dirty = true;
      }

      for (const event of kept) {
        if (!pendingIds.has(event.eventId)) {
          pending.push(event);
          pendingIds.add(event.eventId);
        }
      }
    },

    enqueue(event: DecodedEvent): boolean {
      if (pendingIds.has(event.eventId)) {
        return false;
      }
      pending.push(event);
      pendingIds.add(event.eventId);
      while (pending.length > maxPending) {
        const evicted = pending.shift();
        if (evicted) {
          pendingIds.delete(evicted.eventId);
          dropped += 1;
        }
      }
      dirty = true;
      return true;
    },

    snapshotPending(): DecodedEvent[] {
      return [...pending];
    },

    async acknowledgeSent(eventIds: ReadonlySet<string>): Promise<void> {
      if (eventIds.size > 0) {
        pending = pending.filter((e) => !eventIds.has(e.eventId));
        pendingIds = new Set(pending.map((e) => e.eventId));
      }
      dropped = 0;
      dirty = true;
      await writeToDisk();
    },

    async flush(): Promise<boolean> {
      if (!dirty) return true;
      return writeToDisk();
    },

    async read(): Promise<number | null> {
      return lastRunMs;
    },

    async write(timestampMs: number): Promise<void> {
      lastRunMs = timestampMs;
      dirty = true;
      await writeToDisk();
    },

    stats(): DigestCheckpointStats {
      return {
        pending: pending.length,
        dropped,
        lastRunMs,
        maxPending,
      };
    },
  };
}
