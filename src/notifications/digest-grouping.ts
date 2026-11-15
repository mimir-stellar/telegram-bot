/**
 * Group a flat array of decoded events by claim or squad market.
 *
 * Events from `mimir-market` are keyed by `claimId`; events from `mimir-squad`
 * are keyed by `marketId`. Everything else (admin events, unknowns, or market /
 * squad events whose payload lacks the id field) forms its own singleton group.
 *
 * Group order follows First-Seen insertion order. Within each group events are
 * sorted deterministically by {@link compareEvents}.
 */

import { createHash } from "node:crypto";
import { redactText } from "../redact.js";
import { compareEvents, sortEvents, type DecodedEvent } from "../stellar/decode.js";
import {
  TELEGRAM_MAX_MESSAGE_LENGTH,
  formatDigest,
  isTimeoutError,
  safeErrorMessage,
  splitTelegramMessage,
  type FormatDigestOptions,
} from "./format.js";
import type {
  DigestPageOutcome,
  DigestRecoveryStore,
  PersistedDigestRun,
} from "./schedule.js";

export interface DigestGroup {
  /**
   * Identifier for this group.
   * - `"market:<claimId>"` for mimir-market events that carry a claimId
   * - `"squad:<marketId>"` for mimir-squad events that carry a marketId
   * - `"ungroupable:<eventId>"` for everything else (one event per group)
   */
  key: string;
  events: DecodedEvent[];
}

/**
 * Derive the Group_Key for a single event.
 *
 * Returns a stable, human-readable key used both as the bucket identifier and
 * as the group header text in the digest.
 */
function groupKeyFor(event: DecodedEvent): string {
  const p = event.payload;

  if (event.source === "market" && "claimId" in p && p.claimId !== undefined) {
    return `market:${p.claimId}`;
  }

  if (event.source === "squad" && "marketId" in p && p.marketId !== undefined) {
    return `squad:${p.marketId}`;
  }

  // Admin events, unknown events, and any market/squad event whose payload
  // lacks the expected id field fall here.  Using eventId makes the key unique
  // so each such event forms its own singleton group.
  return `ungroupable:${event.eventId}`;
}

/**
 * Bucket `events` by Group_Key, preserving First-Seen insertion order of keys.
 *
 * Events within each bucket are sorted with {@link compareEvents} (ledger →
 * transaction index → operation index → paging token → tx hash).
 *
 * Returns an empty array when `events` is empty.
 */
export function groupDigestEvents(events: readonly DecodedEvent[]): DigestGroup[] {
  if (events.length === 0) return [];

  // insertion-order Map so the output order of groups mirrors the order in
  // which their keys were first encountered while iterating events.
  const buckets = new Map<string, DecodedEvent[]>();

  for (const event of events) {
    const key = groupKeyFor(event);
    const existing = buckets.get(key);
    if (existing !== undefined) {
      existing.push(event);
    } else {
      buckets.set(key, [event]);
    }
  }

  const groups: DigestGroup[] = [];
  for (const [key, raw] of buckets) {
    groups.push({ key, events: sortEvents(raw) });
  }
  return groups;
}

export const MAX_RECOVERY_DIGEST_PAGES = 32;

export class DigestRecoveryMismatchError extends Error {
  readonly code = "DIGEST_RECOVERY_MISMATCH" as const;
  constructor(message: string) {
    super(message);
    this.name = "DigestRecoveryMismatchError";
  }
}

export interface DigestPageSendContext {
  digestId: string;
  destination: string;
  pageIndex: number;
  totalPages: number;
  pageHash: string;
}

export type DigestPageSender = (
  destination: string,
  pageText: string,
  context: DigestPageSendContext,
) => Promise<void>;

export interface DeliverMultiPageDigestOptions {
  store: DigestRecoveryStore;
  destinations: readonly string[];
  pages?: readonly string[];
  events?: readonly DecodedEvent[];
  formatOptions?: FormatDigestOptions;
  maxPageChars?: number;
  maxPages?: number;
  digestId?: string;
  scheduledAtMs?: number;
  sendPage: DigestPageSender;
  onUncertain?: (outcome: DigestPageOutcome) => void;
  resendUncertain?: boolean;
  now?: () => number;
}

export interface DigestDeliverySummary {
  digestId: string;
  totalPages: number;
  sentPages: DigestPageOutcome[];
  skippedConfirmedPages: DigestPageOutcome[];
  uncertainPages: DigestPageOutcome[];
  failedPages: DigestPageOutcome[];
  outcomesByDestination: Record<string, DigestPageOutcome[]>;
}

export interface RecoverPartialDigestsOptions {
  store: DigestRecoveryStore;
  sendPage: DigestPageSender;
  onUncertain?: (outcome: DigestPageOutcome) => void;
  resendUncertain?: boolean;
  now?: () => number;
}

export function hashDigestPage(pageText: string): string {
  return createHash("sha256").update(pageText, "utf8").digest("hex").slice(0, 16);
}

export function computeDigestRunId(
  scheduledAtMs: number | undefined,
  pageHashes: readonly string[],
): string {
  const seed = `${scheduledAtMs ?? 0}:${pageHashes.join(",")}`;
  return createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 16);
}

export function splitDigestIntoPages(
  events: readonly DecodedEvent[],
  options: { formatOptions?: FormatDigestOptions; maxPageChars?: number } = {},
): string[] {
  const rendered = formatDigest(events, options.formatOptions ?? { grouped: true });
  if (rendered === null) return [];
  const limit = options.maxPageChars ?? TELEGRAM_MAX_MESSAGE_LENGTH;
  return splitTelegramMessage(rendered, limit);
}

function normalizeDestinations(destinations: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of destinations) {
    const trimmed = String(raw ?? "").trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function hasRemainingDeliverablePages(run: PersistedDigestRun): boolean {
  for (const outcomes of Object.values(run.destinations)) {
    for (const outcome of outcomes) {
      if (
        outcome.status === "pending" ||
        outcome.status === "in_flight" ||
        outcome.status === "failed"
      ) {
        return true;
      }
    }
  }
  return false;
}

function cloneOutcomes(
  destinations: Record<string, DigestPageOutcome[]>,
): Record<string, DigestPageOutcome[]> {
  const copy: Record<string, DigestPageOutcome[]> = {};
  for (const [dest, list] of Object.entries(destinations)) {
    copy[dest] = list.map((item) => ({ ...item }));
  }
  return copy;
}

async function executeRunDelivery(
  run: PersistedDigestRun,
  pages: readonly string[],
  options: {
    store: DigestRecoveryStore;
    sendPage: DigestPageSender;
    onUncertain?: (outcome: DigestPageOutcome) => void;
    resendUncertain?: boolean;
    now: () => number;
  },
): Promise<DigestDeliverySummary> {
  const sentPages: DigestPageOutcome[] = [];
  const skippedConfirmedPages: DigestPageOutcome[] = [];
  const uncertainPages: DigestPageOutcome[] = [];
  const failedPages: DigestPageOutcome[] = [];
  const resendUncertain = options.resendUncertain ?? false;

  for (const [destination, outcomes] of Object.entries(run.destinations)) {
    for (let i = 0; i < outcomes.length; i += 1) {
      const outcome = outcomes[i]!;
      const pageText = pages[outcome.pageIndex];

      if (outcome.status === "confirmed") {
        skippedConfirmedPages.push({ ...outcome });
        continue;
      }

      if (outcome.status === "uncertain" && !resendUncertain) {
        uncertainPages.push({ ...outcome });
        options.onUncertain?.({ ...outcome });
        continue;
      }

      if (pageText === undefined) {
        outcome.status = "failed";
        outcome.updatedAt = options.now();
        outcome.error = "missing persisted page payload for recovery";
        run.updatedAt = outcome.updatedAt;
        await options.store.saveRun(run);
        failedPages.push({ ...outcome });
        continue;
      }

      outcome.status = "in_flight";
      outcome.attempts += 1;
      outcome.updatedAt = options.now();
      run.updatedAt = outcome.updatedAt;
      await options.store.saveRun(run);

      try {
        await options.sendPage(destination, pageText, {
          digestId: run.digestId,
          destination,
          pageIndex: outcome.pageIndex,
          totalPages: run.totalPages,
          pageHash: outcome.pageHash,
        });
        outcome.status = "confirmed";
        delete outcome.error;
        outcome.updatedAt = options.now();
        run.updatedAt = outcome.updatedAt;
        await options.store.saveRun(run);
        sentPages.push({ ...outcome });
      } catch (err) {
        const errText = safeErrorMessage(err);
        outcome.updatedAt = options.now();
        outcome.error = errText;
        run.updatedAt = outcome.updatedAt;

        if (isTimeoutError(err)) {
          outcome.status = "uncertain";
          run.uncertainReported = true;
          await options.store.saveRun(run);
          uncertainPages.push({ ...outcome });
          options.onUncertain?.({ ...outcome });
        } else {
          outcome.status = "failed";
          await options.store.saveRun(run);
          failedPages.push({ ...outcome });
        }
      }
    }
  }

  if (uncertainPages.length > 0) {
    run.uncertainReported = true;
  }
  if (!hasRemainingDeliverablePages(run)) {
    delete run.pages;
  }
  run.updatedAt = options.now();
  await options.store.saveRun(run);

  return {
    digestId: run.digestId,
    totalPages: run.totalPages,
    sentPages,
    skippedConfirmedPages,
    uncertainPages,
    failedPages,
    outcomesByDestination: cloneOutcomes(run.destinations),
  };
}

/**
 * Deliver a multi-page digest across one or more destinations while persisting
 * crash-safe page-level outcomes (`pending` -> `in_flight` -> `confirmed` /
 * `uncertain` / `failed`). Re-invoking with the same `digestId` after a restart
 * skips confirmed pages and reports uncertain sends without claiming
 * exactly-once delivery.
 */
export async function deliverMultiPageDigest(
  options: DeliverMultiPageDigestOptions,
): Promise<DigestDeliverySummary> {
  const now = options.now ?? Date.now;
  const destinations = normalizeDestinations(options.destinations);
  const rawPages =
    options.pages ??
    (options.events
      ? splitDigestIntoPages(options.events, {
          formatOptions: options.formatOptions,
          maxPageChars: options.maxPageChars,
        })
      : []);

  if (destinations.length === 0 || rawPages.length === 0) {
    return {
      digestId: options.digestId ?? computeDigestRunId(options.scheduledAtMs, []),
      totalPages: rawPages.length,
      sentPages: [],
      skippedConfirmedPages: [],
      uncertainPages: [],
      failedPages: [],
      outcomesByDestination: {},
    };
  }

  const maxPages = Math.max(1, options.maxPages ?? MAX_RECOVERY_DIGEST_PAGES);
  if (rawPages.length > maxPages) {
    throw new RangeError(
      `Digest page count ${rawPages.length} exceeds recovery bound ${maxPages}`,
    );
  }

  const sanitizedPages = rawPages.map((page) => redactText(page));
  const pageHashes = sanitizedPages.map(hashDigestPage);
  const digestId =
    options.digestId ?? computeDigestRunId(options.scheduledAtMs, pageHashes);

  const existingRuns = await options.store.loadForRecovery(now());
  let run = existingRuns.find((entry) => entry.digestId === digestId);

  if (run) {
    if (
      run.totalPages !== sanitizedPages.length ||
      run.pageHashes.length !== pageHashes.length ||
      run.pageHashes.some((hash, index) => hash !== pageHashes[index])
    ) {
      throw new DigestRecoveryMismatchError(
        `Existing digest run "${digestId}" does not match candidate page hashes`,
      );
    }
    run.pages = sanitizedPages;
    for (const destination of destinations) {
      if (!run.destinations[destination]) {
        const ts = now();
        run.destinations[destination] = pageHashes.map((pageHash, pageIndex) => ({
          digestId,
          destination,
          pageIndex,
          totalPages: sanitizedPages.length,
          pageHash,
          status: "pending",
          attempts: 0,
          updatedAt: ts,
        }));
      }
    }
  } else {
    const ts = now();
    const destinationMap: Record<string, DigestPageOutcome[]> = {};
    for (const destination of destinations) {
      destinationMap[destination] = pageHashes.map((pageHash, pageIndex) => ({
        digestId,
        destination,
        pageIndex,
        totalPages: sanitizedPages.length,
        pageHash,
        status: "pending",
        attempts: 0,
        updatedAt: ts,
      }));
    }
    run = {
      digestId,
      scheduledAtMs: options.scheduledAtMs,
      totalPages: sanitizedPages.length,
      pageHashes,
      pages: sanitizedPages,
      destinations: destinationMap,
      uncertainReported: false,
      createdAt: ts,
      updatedAt: ts,
    };
  }

  await options.store.saveRun(run);
  return executeRunDelivery(run, sanitizedPages, {
    store: options.store,
    sendPage: options.sendPage,
    onUncertain: options.onUncertain,
    resendUncertain: options.resendUncertain,
    now,
  });
}

/**
 * Resume any partially delivered multi-page digests found on disk after a
 * process restart: promotes interrupted `in_flight` sends to `uncertain`,
 * avoids resending `confirmed` pages, reports `uncertain` pages, and delivers
 * remaining `pending` / `failed` pages.
 */
export async function recoverPartialDigests(
  options: RecoverPartialDigestsOptions,
): Promise<DigestDeliverySummary[]> {
  const now = options.now ?? Date.now;
  const runs = await options.store.loadForRecovery(now());
  const summaries: DigestDeliverySummary[] = [];

  for (const run of runs) {
    const hasPendingOrFailed = hasRemainingDeliverablePages(run);
    const hasUnreportedUncertain =
      !run.uncertainReported &&
      Object.values(run.destinations).some((list) =>
        list.some((item) => item.status === "uncertain"),
      );
    if (!hasPendingOrFailed && !hasUnreportedUncertain) continue;

    const pages = run.pages ?? [];
    const summary = await executeRunDelivery(run, pages, {
      store: options.store,
      sendPage: options.sendPage,
      onUncertain: options.onUncertain,
      resendUncertain: options.resendUncertain,
      now,
    });
    summaries.push(summary);
  }

  return summaries;
}

/**
 * Format a bounded, operator-safe summary of uncertain or partial digest page
 * sends observed during recovery.
 */
export function formatDigestRecoveryReport(
  summary: Pick<
    DigestDeliverySummary,
    "digestId" | "totalPages" | "sentPages" | "skippedConfirmedPages" | "uncertainPages" | "failedPages"
  >,
): string {
  const uncertainDetail =
    summary.uncertainPages.length === 0
      ? "none"
      : summary.uncertainPages
          .map(
            (u) =>
              `${u.destination}#p${u.pageIndex + 1}/${u.totalPages}(${u.pageHash.slice(0, 8)})`,
          )
          .join(", ");
  return (
    `digest=${summary.digestId} pages=${summary.totalPages} ` +
    `sent=${summary.sentPages.length} confirmedSkipped=${summary.skippedConfirmedPages.length} ` +
    `uncertain=${summary.uncertainPages.length} [${uncertainDetail}] ` +
    `failed=${summary.failedPages.length}`
  );
}
