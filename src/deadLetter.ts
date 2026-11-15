/**
 * Local dead-letter queue for Telegram sends that exhausted in-cycle retries.
 *
 * Before this, a send that failed every retry was dropped and counted: the
 * cursor advanced (correct — the chain is the source of truth, and a broken
 * token must not wedge the poller) but the notification was gone, and the only
 * trace was one `notificationsFailed` tick and an audit line. The queue parks
 * those messages on disk instead, so a rate limit or a short Telegram outage
 * costs a delay rather than the message.
 *
 * Bounded on every axis, because none of the inputs are trusted:
 *
 *  - Depth: `maxEntries`; the oldest entry is dropped when the queue is full, so
 *    a permanently broken token cannot grow the file without limit.
 *  - Attempts: an entry that fails `maxAttempts` replays is a poison entry and
 *    is dropped, so a message Telegram will never accept cannot be retried
 *    forever.
 *  - Size: the message body and the recorded error are both truncated.
 *  - Content: the stored error goes through `safeErrorMessage`, so a token or a
 *    seed strkey in an upstream error cannot be persisted to the file (the same
 *    rule that governs every other operator-facing string).
 *
 * The queue holds only already-formatted MarkdownV2 text plus short operational
 * metadata. It never holds signing keys or bot tokens.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { safeErrorMessage } from "./notifications/format.js";

export interface DeadLetterNetworkIdentity {
  /** Named Stellar network (e.g. `"testnet"`, `"mainnet"`, `"futurenet"`, `"custom"`). */
  network?: string;
  /** Exact Stellar network passphrase under which the event was observed. */
  networkPassphrase?: string;
}

export interface DeadLetterEntry {
  /** Stable id within the queue (source + ledger + event + short text hash). */
  id: string;
  enqueuedAt: string;
  source: string;
  ledger: number;
  eventName: string;
  /** Already-formatted MarkdownV2 message body, truncated to {@link TEXT_TRUNCATE}. */
  text: string;
  attempts: number;
  lastError: string | null;
  /** Optional network label stored when the entry was parked. */
  network?: string;
  /** Optional network passphrase stored when the entry was parked. */
  networkPassphrase?: string;
}

export interface DeadLetterFile {
  version: 1;
  updatedAt: string;
  entries: DeadLetterEntry[];
}

export interface DeadLetterStats {
  depth: number;
  enqueued: number;
  replayed: number;
  dropped: number;
}

export interface DeadLetterQueueOptions extends DeadLetterNetworkIdentity {
  /**
   * Where the queue lives. `null` disables persistence and loading: the queue
   * then works in memory only, which is how a caller that predates the setting
   * (a hand-built config in a test, a tool) keeps its old behaviour with no
   * file access at all.
   */
  filePath: string | null;
  maxEntries: number;
  maxAttempts: number;
  /**
   * Config secrets to scrub from a recorded error, passed straight to
   * `safeErrorMessage`. The poller hands over its bot token: a Telegram failure
   * routinely embeds the token in the request URL, and main's shape rule
   * deliberately does not match a token that follows the literal `bot` prefix in
   * a URL, so the value itself is what makes that case safe.
   */
  secrets?: readonly string[];
  /** Optional clock for deterministic tests. */
  now?: () => number;
  /** Suppress informational console output (used by machine-readable CLI modes). */
  quiet?: boolean;
}

export class DeadLetterNetworkMismatchError extends Error {
  readonly entryId: string;

  constructor(entryId: string, reason: string) {
    super(`cannot replay dead-letter entry ${entryId}: ${reason}`);
    this.name = "DeadLetterNetworkMismatchError";
    this.entryId = entryId;
  }
}

export const DEAD_LETTER_MAX_ENTRIES = 100;
export const DEAD_LETTER_MAX_ATTEMPTS = 10;

const ERROR_TRUNCATE = 200;
const NETWORK_TRUNCATE = 200;
/** Telegram's own message ceiling (4,096) minus room for the queue's own text. */
const TEXT_TRUNCATE = 4_000;

const WELL_KNOWN_PASSPHRASES: Readonly<Record<string, string>> = {
  testnet: "Test SDF Network ; September 2015",
  mainnet: "Public Global Stellar Network ; September 2015",
  futurenet: "Test SDF Future Network ; October 2022",
};

const WELL_KNOWN_NETWORKS_BY_PASSPHRASE = new Map<string, string>(
  Object.entries(WELL_KNOWN_PASSPHRASES).map(([name, passphrase]) => [passphrase, name]),
);

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

function normalizeOptionalString(value: unknown, maxLen = NETWORK_TRUNCATE): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return truncate(trimmed, maxLen);
}

function resolveNetworkIdentity(identity: DeadLetterNetworkIdentity): {
  network?: string;
  networkPassphrase?: string;
} {
  const rawNetwork = normalizeOptionalString(identity.network)?.toLowerCase();
  const rawPassphrase = normalizeOptionalString(identity.networkPassphrase);
  const networkPassphrase =
    rawPassphrase ?? (rawNetwork ? WELL_KNOWN_PASSPHRASES[rawNetwork] : undefined);
  const network =
    rawNetwork ??
    (rawPassphrase ? (WELL_KNOWN_NETWORKS_BY_PASSPHRASE.get(rawPassphrase) ?? "custom") : undefined);
  return {
    ...(network !== undefined ? { network } : {}),
    ...(networkPassphrase !== undefined ? { networkPassphrase } : {}),
  };
}

/**
 * Compare a dead-letter entry's stored network identity with the active configuration.
 *
 * Legacy entries without stored network fields (or queues constructed without an
 * active network constraint) remain compatible so pre-existing files keep working.
 * Any explicit network or passphrase conflict is rejected.
 */
export function isEntryNetworkCompatible(
  entry: Pick<DeadLetterEntry, "network" | "networkPassphrase">,
  active: DeadLetterNetworkIdentity,
): { compatible: boolean; reason: string | null } {
  const activeId = resolveNetworkIdentity(active);
  if (activeId.network === undefined && activeId.networkPassphrase === undefined) {
    return { compatible: true, reason: null };
  }

  const entryId = resolveNetworkIdentity(entry);
  if (entryId.network === undefined && entryId.networkPassphrase === undefined) {
    return { compatible: true, reason: null };
  }

  if (
    entryId.networkPassphrase !== undefined &&
    activeId.networkPassphrase !== undefined &&
    entryId.networkPassphrase !== activeId.networkPassphrase
  ) {
    const storedLabel = entryId.network ?? entryId.networkPassphrase;
    const activeLabel = activeId.network ?? activeId.networkPassphrase;
    return {
      compatible: false,
      reason: `stored network (${storedLabel}) does not match active configuration (${activeLabel})`,
    };
  }

  if (
    entryId.network !== undefined &&
    activeId.network !== undefined &&
    entryId.network !== activeId.network
  ) {
    return {
      compatible: false,
      reason: `stored network (${entryId.network}) does not match active configuration (${activeId.network})`,
    };
  }

  if (
    entryId.network === "custom" &&
    entryId.networkPassphrase !== undefined &&
    activeId.networkPassphrase === undefined
  ) {
    return {
      compatible: false,
      reason: "stored custom network passphrase cannot be verified without active networkPassphrase",
    };
  }

  if (
    activeId.network === "custom" &&
    activeId.networkPassphrase !== undefined &&
    entryId.networkPassphrase === undefined
  ) {
    return {
      compatible: false,
      reason: "custom network entry lacks networkPassphrase required by active configuration",
    };
  }

  return { compatible: true, reason: null };
}

/** Short non-crypto fingerprint so duplicate failures collapse into one entry. */
function shortHash(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = (h * 31 + text.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Identity of a parked message: the same event failing twice is one entry. */
export function makeEntryId(
  source: string,
  ledger: number,
  eventName: string,
  text: string,
): string {
  return `${source}:${ledger}:${eventName}:${shortHash(text)}`;
}

export function createDeadLetterQueue(options: DeadLetterQueueOptions) {
  const now = options.now ?? Date.now;
  const filePath = options.filePath;
  const quiet = options.quiet === true;
  const configuredNetwork = resolveNetworkIdentity({
    network: options.network,
    networkPassphrase: options.networkPassphrase,
  });
  let entries: DeadLetterEntry[] = [];
  const stats: DeadLetterStats = {
    depth: 0,
    enqueued: 0,
    replayed: 0,
    dropped: 0,
  };

  /** Redacted, truncated error text — the only form that may be persisted. */
  function safeError(err: unknown): string {
    return truncate(safeErrorMessage(err, options.secrets ?? []), ERROR_TRUNCATE);
  }

  function syncDepth(): void {
    stats.depth = entries.length;
  }

  async function load(): Promise<void> {
    if (filePath === null) {
      entries = [];
      syncDepth();
      return;
    }

    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch {
      // No file yet is the normal first-run case, not a problem to report.
      entries = [];
      syncDepth();
      return;
    }

    try {
      const parsed = JSON.parse(raw) as DeadLetterFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
        console.warn(
          `[dead-letter] unknown or corrupt queue at ${filePath}; starting empty`,
        );
        entries = [];
      } else {
        entries = parsed.entries
          .filter(
            (e) =>
              e &&
              typeof e.id === "string" &&
              typeof e.text === "string" &&
              typeof e.ledger === "number",
          )
          .map((e) => {
            const storedNet = normalizeOptionalString(e.network)?.toLowerCase();
            const storedPass = normalizeOptionalString(e.networkPassphrase);
            return {
              id: e.id,
              enqueuedAt:
                typeof e.enqueuedAt === "string" ? e.enqueuedAt : new Date(now()).toISOString(),
              source: typeof e.source === "string" ? e.source : "unknown",
              ledger: e.ledger,
              eventName: typeof e.eventName === "string" ? e.eventName : "unknown",
              text: truncate(e.text, TEXT_TRUNCATE),
              attempts: typeof e.attempts === "number" && e.attempts >= 0 ? e.attempts : 0,
              lastError: typeof e.lastError === "string" ? truncate(e.lastError, ERROR_TRUNCATE) : null,
              ...(storedNet !== undefined ? { network: storedNet } : {}),
              ...(storedPass !== undefined ? { networkPassphrase: storedPass } : {}),
            };
          });
        // Bound on load too: the file may have been edited by hand.
        while (entries.length > options.maxEntries) {
          entries.shift();
          stats.dropped += 1;
        }
      }
    } catch (err) {
      console.warn(
        `[dead-letter] unreadable queue at ${filePath}, starting empty: ${safeError(err)}`,
      );
      entries = [];
    }
    syncDepth();
    if (entries.length > 0 && !quiet) {
      console.log(`[dead-letter] loaded ${entries.length} parked send(s) from ${filePath}`);
    }
  }

  async function persist(): Promise<void> {
    if (filePath === null) {
      syncDepth();
      return;
    }
    const payload: DeadLetterFile = {
      version: 1,
      updatedAt: new Date(now()).toISOString(),
      entries,
    };
    try {
      await mkdir(path.dirname(filePath), { recursive: true });
      // Write-then-rename, like the cursor and status files: a reader never sees
      // a half-written queue, and a crash leaves the previous one intact.
      const tmp = `${filePath}.tmp`;
      await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      await rename(tmp, filePath);
    } catch (err) {
      // An unwritable queue is degraded observability, never a reason to stop
      // notifying or to throw into the poll loop.
      console.error(`[dead-letter] could not persist queue: ${safeError(err)}`);
    }
    syncDepth();
  }

  async function enqueue(input: {
    source: string;
    ledger: number;
    eventName: string;
    text: string;
    error: unknown;
    network?: string;
    networkPassphrase?: string;
  }): Promise<DeadLetterEntry> {
    const id = makeEntryId(input.source, input.ledger, input.eventName, input.text);
    const entryIdentity = resolveNetworkIdentity({
      network: input.network ?? configuredNetwork.network,
      networkPassphrase: input.networkPassphrase ?? configuredNetwork.networkPassphrase,
    });
    const existing = entries.find(
      (e) =>
        e.id === id &&
        isEntryNetworkCompatible(e, entryIdentity).compatible &&
        (e.network ?? undefined) === entryIdentity.network &&
        (e.networkPassphrase ?? undefined) === entryIdentity.networkPassphrase,
    );
    if (existing) {
      existing.attempts += 1;
      existing.lastError = safeError(input.error);
      await persist();
      return existing;
    }

    while (entries.length >= Math.max(1, options.maxEntries)) {
      const dropped = entries.shift();
      stats.dropped += 1;
      if (dropped) {
        console.warn(
          `[dead-letter] queue full (max ${options.maxEntries}); dropped oldest ` +
            `${dropped.source} ${dropped.eventName} @ ledger ${dropped.ledger}`,
        );
      }
    }

    const entry: DeadLetterEntry = {
      id,
      enqueuedAt: new Date(now()).toISOString(),
      source: input.source,
      ledger: input.ledger,
      eventName: input.eventName,
      text: truncate(input.text, TEXT_TRUNCATE),
      attempts: 1,
      lastError: safeError(input.error),
      ...(entryIdentity.network !== undefined ? { network: entryIdentity.network } : {}),
      ...(entryIdentity.networkPassphrase !== undefined
        ? { networkPassphrase: entryIdentity.networkPassphrase }
        : {}),
    };
    entries.push(entry);
    stats.enqueued += 1;
    syncDepth();
    console.warn(
      `[dead-letter] parked ${entry.source} ${entry.eventName} @ ledger ${entry.ledger} ` +
        `(depth ${entries.length}/${options.maxEntries}): ${entry.lastError}`,
    );
    await persist();
    return entry;
  }

  /**
   * Resend parked messages, oldest first. Stops after `budget` successful sends
   * so one recovery cannot flood the channel. Never throws: a failed replay
   * updates the entry in place, and a poison entry is dropped once it has used
   * its attempts.
   */
  async function flush(
    send: (text: string, entry: DeadLetterEntry) => Promise<void>,
    budget: number,
  ): Promise<{ sent: number; remaining: number; incompatible: number }> {
    if (budget <= 0 || entries.length === 0) {
      return { sent: 0, remaining: entries.length, incompatible: 0 };
    }

    let sent = 0;
    let incompatible = 0;
    let mutated = false;
    const kept: DeadLetterEntry[] = [];

    for (const entry of entries) {
      const check = isEntryNetworkCompatible(entry, configuredNetwork);
      if (!check.compatible) {
        incompatible += 1;
        kept.push(entry);
        if (!quiet) {
          console.warn(
            `[dead-letter] skipping replay for ${entry.source} ${entry.eventName} ` +
              `@ ledger ${entry.ledger}: ${check.reason}`,
          );
        }
        continue;
      }

      if (sent >= budget) {
        kept.push(entry);
        continue;
      }

      try {
        await send(entry.text, entry);
        sent += 1;
        mutated = true;
        stats.replayed += 1;
        console.log(
          `[dead-letter] replayed ${entry.source} ${entry.eventName} @ ledger ${entry.ledger}`,
        );
      } catch (err) {
        mutated = true;
        entry.attempts += 1;
        entry.lastError = safeError(err);
        if (entry.attempts >= options.maxAttempts) {
          stats.dropped += 1;
          console.error(
            `[dead-letter] dropping ${entry.source} ${entry.eventName} @ ledger ${entry.ledger} ` +
              `after ${entry.attempts} attempts: ${entry.lastError}`,
          );
        } else {
          kept.push(entry);
          console.warn(
            `[dead-letter] replay failed for ${entry.source} ${entry.eventName} ` +
              `@ ledger ${entry.ledger} (attempt ${entry.attempts}/${options.maxAttempts}): ` +
              entry.lastError,
          );
        }
      }
    }

    entries = kept;
    syncDepth();
    if (mutated) {
      await persist();
    }
    return { sent, remaining: entries.length, incompatible };
  }

  /**
   * Replay a single entry by ID. Rejects with {@link DeadLetterNetworkMismatchError}
   * without calling `send` or mutating the entry if its stored network identity
   * conflicts with the active queue configuration.
   */
  async function replayEntry(
    id: string,
    send: (text: string, entry: DeadLetterEntry) => Promise<void>,
  ): Promise<{ sent: boolean; remaining: number }> {
    const idx = entries.findIndex((e) => e.id === id);
    if (idx === -1) {
      throw new Error(`dead-letter entry not found: ${id}`);
    }
    const entry = entries[idx]!;
    const check = isEntryNetworkCompatible(entry, configuredNetwork);
    if (!check.compatible) {
      throw new DeadLetterNetworkMismatchError(entry.id, check.reason ?? "network mismatch");
    }

    try {
      await send(entry.text, entry);
      entries.splice(idx, 1);
      stats.replayed += 1;
      syncDepth();
      await persist();
      return { sent: true, remaining: entries.length };
    } catch (err) {
      entry.attempts += 1;
      entry.lastError = safeError(err);
      if (entry.attempts >= options.maxAttempts) {
        entries.splice(idx, 1);
        stats.dropped += 1;
      }
      syncDepth();
      await persist();
      throw err;
    }
  }

  return {
    load,
    enqueue,
    flush,
    replayEntry,
    stats(): DeadLetterStats {
      return { ...stats, depth: entries.length };
    },
    /** Test helper — snapshot of current entries. */
    snapshot(): DeadLetterEntry[] {
      return entries.map((e) => ({ ...e }));
    },
  };
}

export type DeadLetterQueue = ReturnType<typeof createDeadLetterQueue>;
