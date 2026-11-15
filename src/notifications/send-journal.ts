/**
 * Crash-safe send journal for Telegram notifications.
 *
 * Before a send is attempted the poller appends an `intent` line; after the
 * send succeeds it appends a matching `done` line. On restart, lines that carry
 * an `intent` but no `done` identify notifications that may or may not have
 * been delivered -- instead of guessing from the cursor.
 *
 * Every append is fsynced before it returns, so a journal entry survives an
 * abrupt termination. The file is JSONL and is kept bounded by compaction:
 * resolved (`intent` + `done`) pairs are dropped, leaving only unresolved
 * intents.
 *
 * The journal is best-effort: a write failure is logged and the poller carries
 * on, falling back to guessing from the cursor exactly as it does today.
 */

import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_SEND_JOURNAL_MAX_ENTRIES = 1_000;
export const DEFAULT_SEND_JOURNAL_MAX_BYTES = 1_000_000;

export type JournalEntryKind = "intent" | "done" | "discarded" | "rerouted";
export type JournalOrphanReason = "removed_route" | "changed_network";

export interface JournalEntry {
  kind: JournalEntryKind;
  id: string;
  source: string;
  ledger: number;
  eventName: string;
  /** Bounded hash of the message body; the body itself is never persisted. */
  textHash?: string;
  /** Logical route name (e.g. `"market"`, `"squad"`, `"default"`). */
  route?: string;
  /** Short non-reversible digest of the target destination chat identifier. */
  destinationHash?: string;
  /** Canonical Stellar network label when recorded. */
  network?: string;
  /** Stellar network passphrase when recorded. */
  networkPassphrase?: string;
  /** Bounded operator reason recorded on discard or reroute transitions. */
  reason?: string;
  at: number;
}

export interface JournalRuntimeConfig {
  /** Active logical route names currently configured (e.g. `["market", "squad"]`). */
  activeRoutes?: readonly string[];
  /**
   * Active destination chat IDs or a `route -> chatId` mapping. Hashed before
   * comparison so raw private chat IDs never need to be stored in the journal.
   */
  activeDestinations?: readonly string[] | Readonly<Record<string, string>>;
  /** Active Stellar network label. */
  network?: string;
  /** Active Stellar network passphrase. */
  networkPassphrase?: string;
}

export interface OrphanedJournalEntry {
  entry: JournalEntry;
  reasons: JournalOrphanReason[];
}

export type OrphanRecoveryDecision =
  | { action: "discard"; reason?: string }
  | {
      action: "reroute";
      targetRoute: string;
      targetChatId?: string;
      network?: string;
      networkPassphrase?: string;
      reason?: string;
    };

export class OrphanDecisionRequiredError extends Error {
  readonly entryId: string;
  readonly reasons: readonly JournalOrphanReason[];

  constructor(entryId: string, reasons: readonly JournalOrphanReason[], detail?: string) {
    const suffix = detail ? `: ${detail}` : "";
    super(
      `orphaned journal entry ${entryId} (${reasons.join(", ")}) requires an explicit discard or reroute decision${suffix}`,
    );
    this.name = "OrphanDecisionRequiredError";
    this.entryId = entryId;
    this.reasons = [...reasons];
  }
}

export interface SendJournalOptions {
  filePath: string;
  maxEntries?: number;
  maxBytes?: number;
  now?: () => number;
}

export interface SendJournalStats {
  entries: number;
  bytes: number;
}

export interface SendJournal {
  recordIntent(entry: {
    id: string;
    source: string;
    ledger: number;
    eventName: string;
    textHash?: string;
    route?: string;
    chatId?: string;
    destinationHash?: string;
    network?: string;
    networkPassphrase?: string;
    at: number;
  }): Promise<void>;
  recordDone(id: string): Promise<void>;
  /** Intents with no matching done or discard: notifications that may have been sent. */
  loadPending(): Promise<JournalEntry[]>;
  /**
   * Classify unresolved intents against the current runtime configuration,
   * separating compatible pending intents from orphaned entries whose route was
   * removed or whose network identity changed.
   */
  inspectRecovery(runtime: JournalRuntimeConfig): Promise<{
    activePending: JournalEntry[];
    orphaned: OrphanedJournalEntry[];
  }>;
  /**
   * Apply an explicit operator decision (`discard` or `reroute`) to an orphaned
   * journal entry. Rejects missing or invalid decisions with {@link OrphanDecisionRequiredError}.
   */
  resolveOrphan(
    id: string,
    decision: OrphanRecoveryDecision,
    runtime?: JournalRuntimeConfig,
  ): Promise<JournalEntry | null>;
  compact(): Promise<void>;
  stats(): Promise<SendJournalStats>;
}

const WELL_KNOWN_PASSPHRASES: Readonly<Record<string, string>> = {
  testnet: "Test SDF Network ; September 2015",
  mainnet: "Public Global Stellar Network ; September 2015",
  futurenet: "Test SDF Future Network ; October 2022",
};

const WELL_KNOWN_NETWORKS_BY_PASSPHRASE = new Map<string, string>(
  Object.entries(WELL_KNOWN_PASSPHRASES).map(([name, passphrase]) => [passphrase, name]),
);

/** Short non-reversible digest of a destination chat identifier. */
export function hashJournalDestination(chatId: string): string {
  return createHash("sha256").update(chatId.trim()).digest("hex").slice(0, 16);
}

function normalizeBounded(value: unknown, maxLen = 200): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  return trimmed.length <= maxLen ? trimmed : trimmed.slice(0, maxLen);
}

function canonicalNetwork(input: { network?: string; networkPassphrase?: string }): {
  network?: string;
  networkPassphrase?: string;
} {
  const rawNet = normalizeBounded(input.network)?.toLowerCase();
  const rawPass = normalizeBounded(input.networkPassphrase);
  const networkPassphrase = rawPass ?? (rawNet ? WELL_KNOWN_PASSPHRASES[rawNet] : undefined);
  const network =
    rawNet ??
    (rawPass ? (WELL_KNOWN_NETWORKS_BY_PASSPHRASE.get(rawPass) ?? "custom") : undefined);
  return {
    ...(network !== undefined ? { network } : {}),
    ...(networkPassphrase !== undefined ? { networkPassphrase } : {}),
  };
}

export function classifyJournalOrphanReasons(
  entry: JournalEntry,
  runtime: JournalRuntimeConfig,
): JournalOrphanReason[] {
  const reasons: JournalOrphanReason[] = [];

  // 1. Route / destination removal check
  const routeMap =
    runtime.activeDestinations && !Array.isArray(runtime.activeDestinations)
      ? (runtime.activeDestinations as Readonly<Record<string, string>>)
      : null;

  const activeRouteSet =
    runtime.activeRoutes !== undefined
      ? new Set(runtime.activeRoutes.map((r) => r.trim()).filter((r) => r.length > 0))
      : routeMap !== null
        ? new Set(
            Object.entries(routeMap)
              .filter(([, chat]) => typeof chat === "string" && chat.trim().length > 0)
              .map(([route]) => route.trim()),
          )
        : null;

  const activeDestHashes =
    runtime.activeDestinations !== undefined
      ? new Set(
          (Array.isArray(runtime.activeDestinations)
            ? runtime.activeDestinations
            : Object.values(runtime.activeDestinations)
          )
            .filter((c): c is string => typeof c === "string" && c.trim().length > 0)
            .map((c) => hashJournalDestination(c)),
        )
      : null;

  let routeRemoved = false;
  if (entry.route !== undefined && activeRouteSet !== null && !activeRouteSet.has(entry.route)) {
    routeRemoved = true;
  }
  if (entry.destinationHash !== undefined && activeDestHashes !== null) {
    if (
      routeMap !== null &&
      entry.route !== undefined &&
      typeof routeMap[entry.route] === "string" &&
      routeMap[entry.route]!.trim().length > 0
    ) {
      if (hashJournalDestination(routeMap[entry.route]!) !== entry.destinationHash) {
        routeRemoved = true;
      }
    } else if (!activeDestHashes.has(entry.destinationHash)) {
      routeRemoved = true;
    }
  }
  if (routeRemoved) {
    reasons.push("removed_route");
  }

  // 2. Network identity change check
  const entryNet = canonicalNetwork(entry);
  const activeNet = canonicalNetwork(runtime);
  const hasEntryNet = entryNet.network !== undefined || entryNet.networkPassphrase !== undefined;
  const hasActiveNet = activeNet.network !== undefined || activeNet.networkPassphrase !== undefined;

  if (hasEntryNet && hasActiveNet) {
    let networkChanged = false;
    if (
      entryNet.networkPassphrase !== undefined &&
      activeNet.networkPassphrase !== undefined &&
      entryNet.networkPassphrase !== activeNet.networkPassphrase
    ) {
      networkChanged = true;
    } else if (
      entryNet.network !== undefined &&
      activeNet.network !== undefined &&
      entryNet.network !== activeNet.network
    ) {
      networkChanged = true;
    } else if (
      (entryNet.network === "custom" &&
        entryNet.networkPassphrase !== undefined &&
        activeNet.networkPassphrase === undefined) ||
      (activeNet.network === "custom" &&
        activeNet.networkPassphrase !== undefined &&
        entryNet.networkPassphrase === undefined)
    ) {
      networkChanged = true;
    }
    if (networkChanged) {
      reasons.push("changed_network");
    }
  }

  return reasons;
}

function line(entry: JournalEntry): string {
  return JSON.stringify(entry);
}

function isDoneError(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

export function createSendJournal(options: SendJournalOptions): SendJournal {
  const filePath = options.filePath;
  const dir = path.dirname(filePath);
  const maxEntries = Math.max(0, options.maxEntries ?? DEFAULT_SEND_JOURNAL_MAX_ENTRIES);
  const maxBytes = Math.max(0, options.maxBytes ?? DEFAULT_SEND_JOURNAL_MAX_BYTES);
  const now = options.now ?? Date.now;

  async function ensureDir(): Promise<void> {
    await mkdir(dir, { recursive: true });
  }

  /** Append one JSONL line and fsync so it survives a crash. */
  async function append(entry: JournalEntry): Promise<void> {
    await ensureDir();
    const handle = await open(filePath, "a");
    try {
      await handle.write(`${line(entry)}\n`);
      await handle.sync();
    } finally {
      await handle.close().catch(() => {});
    }
  }

  async function readLines(): Promise<JournalEntry[]> {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (err) {
      if (isDoneError(err)) return [];
      throw err;
    }
    const out: JournalEntry[] = [];
    for (const ln of raw.split("\n")) {
      const trimmed = ln.trim();
      if (trimmed === "") continue;
      try {
        out.push(JSON.parse(trimmed) as JournalEntry);
      } catch {
        // A torn or corrupt line is skipped rather than failing the journal.
      }
    }
    return out;
  }

  /** Atomically rewrite the journal with the given entries and fsync. */
  async function persist(entries: JournalEntry[]): Promise<void> {
    await ensureDir();
    const tmp = `${filePath}.tmp`;
    const handle = await open(tmp, "w");
    try {
      for (const entry of entries) await handle.write(`${line(entry)}\n`);
      await handle.sync();
    } finally {
      await handle.close().catch(() => {});
    }
    await rename(tmp, filePath);
    // Best-effort directory fsync so the rename itself is durable.
    try {
      const dirHandle = await open(dir, "r");
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close().catch(() => {});
      }
    } catch {
      // Directory fsync is unsupported on some platforms; the file fsync is
      // the durable part that matters for crash recovery.
    }
  }

  async function recordIntent(entry: {
    id: string;
    source: string;
    ledger: number;
    eventName: string;
    textHash?: string;
    route?: string;
    chatId?: string;
    destinationHash?: string;
    network?: string;
    networkPassphrase?: string;
    at: number;
  }): Promise<void> {
    const route = normalizeBounded(entry.route, 64);
    const destinationHash =
      normalizeBounded(entry.destinationHash, 64) ??
      (typeof entry.chatId === "string" && entry.chatId.trim().length > 0
        ? hashJournalDestination(entry.chatId)
        : undefined);
    const net = canonicalNetwork({
      network: entry.network,
      networkPassphrase: entry.networkPassphrase,
    });
    await append({
      kind: "intent",
      id: entry.id,
      source: entry.source,
      ledger: entry.ledger,
      eventName: entry.eventName,
      ...(entry.textHash !== undefined ? { textHash: entry.textHash } : {}),
      ...(route !== undefined ? { route } : {}),
      ...(destinationHash !== undefined ? { destinationHash } : {}),
      ...(net.network !== undefined ? { network: net.network } : {}),
      ...(net.networkPassphrase !== undefined ? { networkPassphrase: net.networkPassphrase } : {}),
      at: entry.at,
    });
  }

  async function recordDone(id: string): Promise<void> {
    await append({ kind: "done", id, source: "", ledger: 0, eventName: "", at: now() });
    // Once a send is accounted for, compact resolved pairs away when the file
    // has grown past its budget so the journal stays bounded.
    const stats = await journalStats();
    if (stats.entries > maxEntries || stats.bytes > maxBytes) {
      await compact();
    }
  }

  function foldUnresolvedIntents(entries: readonly JournalEntry[]): JournalEntry[] {
    const settled = new Set<string>();
    const reroutes = new Map<string, JournalEntry>();
    for (const entry of entries) {
      if (entry.kind === "done" || entry.kind === "discarded") {
        settled.add(entry.id);
      } else if (entry.kind === "rerouted") {
        reroutes.set(entry.id, entry);
      }
    }

    const out: JournalEntry[] = [];
    for (const entry of entries) {
      if (entry.kind !== "intent" || settled.has(entry.id)) continue;
      const rerouted = reroutes.get(entry.id);
      if (!rerouted) {
        out.push(entry);
        continue;
      }
      out.push({
        ...entry,
        ...(rerouted.route !== undefined ? { route: rerouted.route } : {}),
        ...(rerouted.destinationHash !== undefined
          ? { destinationHash: rerouted.destinationHash }
          : {}),
        ...(rerouted.network !== undefined ? { network: rerouted.network } : {}),
        ...(rerouted.networkPassphrase !== undefined
          ? { networkPassphrase: rerouted.networkPassphrase }
          : {}),
      });
    }
    return out;
  }

  async function loadPending(): Promise<JournalEntry[]> {
    const entries = await readLines();
    return foldUnresolvedIntents(entries);
  }

  async function inspectRecovery(runtime: JournalRuntimeConfig): Promise<{
    activePending: JournalEntry[];
    orphaned: OrphanedJournalEntry[];
  }> {
    const pending = await loadPending();
    const activePending: JournalEntry[] = [];
    const orphaned: OrphanedJournalEntry[] = [];

    for (const entry of pending) {
      const reasons = classifyJournalOrphanReasons(entry, runtime);
      if (reasons.length > 0) {
        orphaned.push({ entry, reasons });
      } else {
        activePending.push(entry);
      }
    }

    return { activePending, orphaned };
  }

  async function resolveOrphan(
    id: string,
    decision: OrphanRecoveryDecision,
    runtime?: JournalRuntimeConfig,
  ): Promise<JournalEntry | null> {
    const targetId = normalizeBounded(id, 256);
    if (!targetId) {
      throw new OrphanDecisionRequiredError(String(id), [], "entry id is required");
    }

    const pending = await loadPending();
    const current = pending.find((e) => e.id === targetId);
    if (!current) {
      throw new Error(`unresolved journal entry not found: ${targetId}`);
    }

    const orphanReasons = runtime ? classifyJournalOrphanReasons(current, runtime) : [];
    if (!decision || (decision.action !== "discard" && decision.action !== "reroute")) {
      throw new OrphanDecisionRequiredError(
        targetId,
        orphanReasons,
        "decision action must be 'discard' or 'reroute'",
      );
    }

    if (decision.action === "discard") {
      await append({
        kind: "discarded",
        id: targetId,
        source: current.source,
        ledger: current.ledger,
        eventName: current.eventName,
        reason: normalizeBounded(decision.reason, 160) ?? "operator_discard",
        at: now(),
      });
      return null;
    }

    const targetRoute = normalizeBounded(decision.targetRoute, 64);
    if (!targetRoute) {
      throw new OrphanDecisionRequiredError(
        targetId,
        orphanReasons,
        "reroute requires a non-empty targetRoute",
      );
    }

    let targetChatId = decision.targetChatId;
    if (runtime) {
      const routeMap =
        runtime.activeDestinations && !Array.isArray(runtime.activeDestinations)
          ? (runtime.activeDestinations as Readonly<Record<string, string>>)
          : null;
      if (
        runtime.activeRoutes !== undefined &&
        !runtime.activeRoutes.map((r) => r.trim()).includes(targetRoute)
      ) {
        throw new OrphanDecisionRequiredError(
          targetId,
          orphanReasons,
          `targetRoute "${targetRoute}" is not an active configured route`,
        );
      }
      if (routeMap !== null) {
        const mappedChat = routeMap[targetRoute];
        if (!mappedChat || mappedChat.trim() === "") {
          throw new OrphanDecisionRequiredError(
            targetId,
            orphanReasons,
            `targetRoute "${targetRoute}" has no configured destination`,
          );
        }
        targetChatId = targetChatId ?? mappedChat;
      }
    }

    const activeNet = canonicalNetwork({
      network: decision.network ?? runtime?.network,
      networkPassphrase: decision.networkPassphrase ?? runtime?.networkPassphrase,
    });
    const nextDestHash =
      typeof targetChatId === "string" && targetChatId.trim().length > 0
        ? hashJournalDestination(targetChatId)
        : current.destinationHash;

    const rerouteRecord: JournalEntry = {
      kind: "rerouted",
      id: targetId,
      source: current.source,
      ledger: current.ledger,
      eventName: current.eventName,
      route: targetRoute,
      ...(nextDestHash !== undefined ? { destinationHash: nextDestHash } : {}),
      ...(activeNet.network !== undefined
        ? { network: activeNet.network }
        : current.network !== undefined
          ? { network: current.network }
          : {}),
      ...(activeNet.networkPassphrase !== undefined
        ? { networkPassphrase: activeNet.networkPassphrase }
        : current.networkPassphrase !== undefined
          ? { networkPassphrase: current.networkPassphrase }
          : {}),
      ...(decision.reason !== undefined ? { reason: normalizeBounded(decision.reason, 160) } : {}),
      at: now(),
    };
    await append(rerouteRecord);

    return {
      ...current,
      route: rerouteRecord.route,
      ...(rerouteRecord.destinationHash !== undefined
        ? { destinationHash: rerouteRecord.destinationHash }
        : {}),
      ...(rerouteRecord.network !== undefined ? { network: rerouteRecord.network } : {}),
      ...(rerouteRecord.networkPassphrase !== undefined
        ? { networkPassphrase: rerouteRecord.networkPassphrase }
        : {}),
    };
  }

  async function compact(): Promise<void> {
    const entries = await readLines();
    // A done or discarded line settles its intent: settled pairs can be dropped,
    // and rerouted metadata is folded onto remaining unresolved intents.
    const unresolved = foldUnresolvedIntents(entries);
    await persist(unresolved);
  }

  async function journalStats(): Promise<SendJournalStats> {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (err) {
      if (isDoneError(err)) return { entries: 0, bytes: 0 };
      throw err;
    }
    let entries = 0;
    for (const ln of raw.split("\n")) {
      if (ln.trim() !== "") entries += 1;
    }
    return { entries, bytes: Buffer.byteLength(raw, "utf8") };
  }

  async function stats(): Promise<SendJournalStats> {
    return journalStats();
  }

  return {
    recordIntent,
    recordDone,
    loadPending,
    inspectRecovery,
    resolveOrphan,
    compact,
    stats,
  };
}
