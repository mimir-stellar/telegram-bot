/**
 * Compare two Soroban RPC endpoints for event consistency.
 *
 * Reads the same contract + ledger range from both endpoints (reusing the
 * cursor-paginated reader in src/stellar/events.ts) and diffs the results by
 * event id and payload, reporting missing, extra and differing events.
 *
 * Intended for operators switching RPC providers who need to verify the new
 * endpoint returns the same events as the old one.
 *
 * Exit codes:
 *   0  both endpoints returned identical events in range
 *   1  events differ (missing / extra / differing payload)
 *   2  usage error, network failure, or one endpoint errored
 *
 * URLs are redacted with redactUrl before any operator-facing output, and the
 * number of RPC pages fetched is bounded by a shared request budget so the tool
 * can never crawl unbounded history.
 *
 *   npx tsx src/rpc-compare-cli.ts \
 *     --rpc-a http://old.example \
 *     --rpc-b http://new.example \
 *     --contract CA... \
 *     --from 900 --to 1000 --budget 40
 */

import { pathToFileURL } from "node:url";

import { rpc } from "@stellar/stellar-sdk";

import { createRpcServer } from "./stellar/client.js";
import { EVENT_MAX_PAGES, EVENT_PAGE_LIMIT, paginatedGetEvents } from "./stellar/events.js";
import { redactText, redactUrl } from "./redact.js";

/** Max differing/missing/extra events listed per category in human output. */
export const DIFF_LIST_MAX = 10;
/** Max field-level diffs printed for a single differing event. */
export const FIELD_DIFF_MAX = 5;
/** Max characters shown for any single payload value. */
export const VALUE_DISPLAY_MAX = 120;
/** Default total page budget across both endpoints (not counting health probes). */
export const DEFAULT_BUDGET = 40;

/** A single field-level difference between two copies of the same event. */
export interface FieldDiff {
  field: string;
  a: unknown;
  b: unknown;
}

/** One event that disagrees between the two endpoints. */
export interface EventDiff {
  id: string;
  ledger: number;
  status: "missing" | "extra" | "differing";
  /** Field-level changes, only present for `differing`. */
  fields?: FieldDiff[];
  /** Truncated snapshot of each side's payload for display. */
  a?: unknown;
  b?: unknown;
}

/** Result of comparing two endpoints. */
export interface CompareResult {
  exitCode: 0 | 1 | 2;
  rpcA: string;
  rpcB: string;
  contractId: string;
  fromLedger: number;
  toLedger: number | null;
  pagesA: number;
  pagesB: number;
  eventsA: number;
  eventsB: number;
  truncatedA: boolean;
  truncatedB: boolean;
  diffs: EventDiff[];
  diffCount: number;
  error?: string;
}

/** CLI options. */
export interface CompareOptions {
  rpcA: string;
  rpcB: string;
  contractId: string;
  fromLedger?: number;
  toLedger?: number;
  pages?: number;
  budget?: number;
  json?: boolean;
}

const CONTRACT_ID_RE = /^C[A-Z2-7]{55}$/;

function isValidContractId(value: unknown): value is string {
  return typeof value === "string" && CONTRACT_ID_RE.test(value.trim());
}

function parseUrl(value: string, label: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error(`Invalid ${label} URL: ${value.slice(0, 60)}`);
  }
}

function createServer(url: string): rpc.Server {
  const parsed = parseUrl(url, "RPC");
  return new rpc.Server(url, {
    allowHttp: parsed.protocol === "http:",
    timeout: 15000,
  });
}

/** Normalize bigints so two payloads can be compared deterministically. */
function normalizeValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = normalizeValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  const na = normalizeValue(a);
  const nb = normalizeValue(b);
  if (typeof na !== typeof nb) return false;
  if (Array.isArray(na) && Array.isArray(nb)) {
    if (na.length !== nb.length) return false;
    return na.every((item, i) => valuesEqual(item, nb[i]));
  }
  if (na && nb && typeof na === "object" && typeof nb === "object") {
    const aKeys = Object.keys(na as Record<string, unknown>).sort();
    const bKeys = Object.keys(nb as Record<string, unknown>).sort();
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) =>
      valuesEqual((na as Record<string, unknown>)[key], (nb as Record<string, unknown>)[key]),
    );
  }
  return na === nb;
}

/** The payload-relevant fields of a raw event, stable across page splits. */
function eventPayload(event: rpc.Api.EventResponse): Record<string, unknown> {
  return {
    ledger: event.ledger,
    txHash: event.txHash,
    contractId: event.contractId,
    type: event.type,
    topic: event.topic,
    value: event.value,
    transactionIndex: event.transactionIndex,
    operationIndex: event.operationIndex,
    inSuccessfulContractCall: event.inSuccessfulContractCall,
  };
}

function fieldDiffs(a: Record<string, unknown>, b: Record<string, unknown>): FieldDiff[] {
  const keys = Array.from(new Set([...Object.keys(a), ...Object.keys(b)])).sort();
  const diffs: FieldDiff[] = [];
  for (const key of keys) {
    const hasA = Object.prototype.hasOwnProperty.call(a, key);
    const hasB = Object.prototype.hasOwnProperty.call(b, key);
    if (!hasA) diffs.push({ field: key, a: undefined, b: b[key] });
    else if (!hasB) diffs.push({ field: key, a: a[key], b: undefined });
    else if (!valuesEqual(a[key], b[key])) diffs.push({ field: key, a: a[key], b: b[key] });
  }
  return diffs;
}

function truncateValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > VALUE_DISPLAY_MAX
      ? `${value.slice(0, VALUE_DISPLAY_MAX - 1)}…`
      : value;
  }
  if (Array.isArray(value)) return value.map(truncateValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      out[key] = truncateValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Fetch contract events from one endpoint, filtered to the inclusive range
 * [fromLedger, toLedger] when toLedger is set.
 *
 * Reuses paginatedGetEvents so the comparison exercises the same cursor
 * pagination, clamping, and window validation the bot itself uses. Pages past
 * `toLedger` may still be walked (bounded by maxPages/budget) but are dropped
 * from the returned set, so the diff is exact for the requested range.
 */
async function fetchRange(
  server: rpc.Server,
  url: string,
  contractId: string,
  opts: { fromLedger: number; toLedger: number | null; maxPages: number },
): Promise<{
  events: rpc.Api.EventResponse[];
  pages: number;
  truncated: boolean;
  oldestLedger: number;
  latestLedger: number;
  startLedger: number | null;
  error?: string;
}> {
  const filters: rpc.Api.EventFilter[] = [{ type: "contract", contractIds: [contractId] }];
  let scan;
  try {
    scan = await paginatedGetEvents(server, filters, {
      startLedger: opts.fromLedger,
      maxPages: opts.maxPages,
    });
  } catch (err) {
    return {
      events: [],
      pages: 0,
      truncated: false,
      oldestLedger: 0,
      latestLedger: 0,
      startLedger: null,
      error: redactText(`failed to read ${redactUrl(url)}: ${boundedError(err)}`),
    };
  }

  let events = scan.events;
  if (opts.toLedger !== null) {
    events = events.filter((e) => e.ledger >= opts.fromLedger && e.ledger <= opts.toLedger!);
  }

  return {
    events,
    pages: scan.pages,
    truncated: scan.truncated,
    oldestLedger: scan.oldestLedger,
    latestLedger: scan.latestLedger,
    startLedger: scan.startLedger,
  };
}

function boundedError(err: unknown): string {
  if (err instanceof Error) {
    let text = err.message;
    if (err.name && err.name !== "Error") text = `${err.name}: ${text}`;
    text = text.replace(/\s+/g, " ").trim();
    return text.length <= 200 ? text : `${text.slice(0, 199)}…`;
  }
  const text = String(err || "unknown error").replace(/\s+/g, " ").trim();
  return text.length <= 200 ? text : `${text.slice(0, 199)}…`;
}

/**
 * Compare two endpoints for event consistency over the same contract + range.
 */
export async function compareEndpoints(opts: CompareOptions): Promise<CompareResult> {
  const base: CompareResult = {
    exitCode: 0,
    rpcA: redactUrl(opts.rpcA),
    rpcB: redactUrl(opts.rpcB),
    contractId: opts.contractId,
    fromLedger: opts.fromLedger ?? 1,
    toLedger: opts.toLedger ?? null,
    pagesA: 0,
    pagesB: 0,
    eventsA: 0,
    eventsB: 0,
    truncatedA: false,
    truncatedB: false,
    diffs: [],
    diffCount: 0,
  };

  // ── Validate inputs before any network call ─────────────────────────────
  if (!isValidContractId(opts.contractId)) {
    return { ...base, exitCode: 2, error: `Invalid contract ID: ${opts.contractId.slice(0, 60)}` };
  }

  let budget = opts.budget ?? DEFAULT_BUDGET;
  if (!Number.isFinite(budget) || !Number.isInteger(budget) || budget < 2) {
    return {
      ...base,
      exitCode: 2,
      error: `--budget must be an integer >= 2 (one page per endpoint); got ${budget}`,
    };
  }
  const perEndpoint = Math.max(1, Math.floor(budget / 2));
  const maxPages = Math.max(1, Math.min(opts.pages ?? EVENT_MAX_PAGES, perEndpoint));

  const fromLedger = opts.fromLedger ?? 1;
  const toLedger = opts.toLedger ?? null;
  if (toLedger !== null && toLedger < fromLedger) {
    return {
      ...base,
      exitCode: 2,
      error: `--to ${toLedger} is before --from ${fromLedger}`,
    };
  }

  // ── Fetch from both endpoints ───────────────────────────────────────────
  const serverA = createServer(opts.rpcA);
  const serverB = createServer(opts.rpcB);

  let resultA: Awaited<ReturnType<typeof fetchRange>>;
  let resultB: Awaited<ReturnType<typeof fetchRange>>;
  try {
    [resultA, resultB] = await Promise.all([
      fetchRange(serverA, opts.rpcA, opts.contractId, {
        fromLedger,
        toLedger,
        maxPages,
      }),
      fetchRange(serverB, opts.rpcB, opts.contractId, {
        fromLedger,
        toLedger,
        maxPages,
      }),
    ]);
  } catch (err) {
    return {
      ...base,
      exitCode: 2,
      error: redactText(`Comparison failed: ${boundedError(err)}`),
    };
  }

  // ── Surface endpoint errors ─────────────────────────────────────────────
  if (resultA.error || resultB.error) {
    return {
      ...base,
      exitCode: 2,
      pagesA: resultA.pages,
      pagesB: resultB.pages,
      eventsA: resultA.events.length,
      eventsB: resultB.events.length,
      truncatedA: resultA.truncated,
      truncatedB: resultB.truncated,
      error: resultA.error ?? resultB.error,
    };
  }

  // ── Diff by event id and payload ────────────────────────────────────────
  const mapA = new Map<string, rpc.Api.EventResponse>();
  const mapB = new Map<string, rpc.Api.EventResponse>();
  for (const event of resultA.events) if (event.id) mapA.set(event.id, event);
  for (const event of resultB.events) if (event.id) mapB.set(event.id, event);

  const diffs: EventDiff[] = [];
  const allIds = new Set([...mapA.keys(), ...mapB.keys()]);
  for (const id of allIds) {
    const a = mapA.get(id);
    const b = mapB.get(id);
    if (!a && b) {
      diffs.push({
        id,
        ledger: b.ledger,
        status: "extra",
        b: truncateValue(eventPayload(b)),
      });
    } else if (a && !b) {
      diffs.push({
        id,
        ledger: a.ledger,
        status: "missing",
        a: truncateValue(eventPayload(a)),
      });
    } else if (a && b) {
      const fields = fieldDiffs(eventPayload(a), eventPayload(b));
      if (fields.length > 0) {
        diffs.push({
          id,
          ledger: b.ledger,
          status: "differing",
          fields: fields.slice(0, FIELD_DIFF_MAX),
          a: truncateValue(eventPayload(a)),
          b: truncateValue(eventPayload(b)),
        });
      }
    }
  }

  // Deterministic order: by ledger then id.
  diffs.sort((x, y) => {
    if (x.ledger !== y.ledger) return x.ledger - y.ledger;
    return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
  });

  const exitCode: 0 | 1 | 2 = diffs.length > 0 ? 1 : 0;

  return {
    ...base,
    exitCode,
    pagesA: resultA.pages,
    pagesB: resultB.pages,
    eventsA: resultA.events.length,
    eventsB: resultB.events.length,
    truncatedA: resultA.truncated,
    truncatedB: resultB.truncated,
    diffs,
    diffCount: diffs.length,
  };
}

/** Render a single field diff line, bounded. */
function formatFieldDiff(f: FieldDiff): string {
  return `  ${f.field}: ${renderValue(f.a)} -> ${renderValue(f.b)}`;
}

function renderValue(value: unknown): string {
  if (value === undefined) return "<absent>";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(normalizeValue(value));
  } catch {
    return String(value);
  }
}

/** Human-readable report, output length bounded. */
export function formatCompareResult(result: CompareResult): string {
  const lines: string[] = [];
  lines.push(`RPC compare: ${result.rpcA} vs ${result.rpcB}`);
  lines.push(`contract ${result.contractId} ledgers ${result.fromLedger}..${result.toLedger ?? "tip"}`);
  lines.push(
    `pages ${result.pagesA}/${result.pagesB} events ${result.eventsA}/${result.eventsB} ` +
      `truncated ${result.truncatedA}/${result.truncatedB}`,
  );

  if (result.error) {
    lines.push(`ERROR ${result.error}`);
    return lines.join("\n") + "\n";
  }

  if (result.diffCount === 0) {
    lines.push("Identical: no missing, extra, or differing events.");
    return lines.join("\n") + "\n";
  }

  lines.push(`Differences: ${result.diffCount} total`);

  const byStatus: Record<string, EventDiff[]> = { missing: [], extra: [], differing: [] };
  for (const d of result.diffs) byStatus[d.status].push(d);

  const show = (status: string, label: string) => {
    const items = byStatus[status] ?? [];
    const shown = items.slice(0, DIFF_LIST_MAX);
    lines.push(`${label}: ${items.length} (showing ${shown.length})`);
    for (const d of shown) {
      lines.push(`  [${status.toUpperCase()}] ledger=${d.ledger} id=${d.id}`);
      if (d.fields) {
        for (const f of d.fields) lines.push(formatFieldDiff(f));
      }
    }
    if (items.length > shown.length) {
      lines.push(`  …and ${items.length - shown.length} more ${status} event(s)`);
    }
  };

  show("missing", "Missing from B");
  show("extra", "Extra in B");
  show("differing", "Differing payload");

  return lines.join("\n") + "\n";
}

/** Machine-readable JSON report. */
export function formatCompareJson(result: CompareResult): string {
  return JSON.stringify(result, (key, value) => (typeof value === "bigint" ? value.toString() : value), 2) + "\n";
}

// ── CLI entrypoint ────────────────────────────────────────────────────────

const HELP_TEXT = `
Usage: npx tsx src/rpc-compare-cli.ts --rpc-a URL --rpc-b URL --contract ID [options]

Compare two Soroban RPC endpoints for event consistency over the same contract
and ledger range. Reports missing, extra, and differing events.

Options:
  --rpc-a <url>   First RPC endpoint (required)
  --rpc-b <url>   Second RPC endpoint (required)
  --contract <id> Soroban contract ID to compare (required)
  --from <ledger> Start ledger, inclusive (default: retained floor)
  --to <ledger>   End ledger, inclusive (default: chain tip)
  --pages <n>     Max pages per endpoint (default: ${EVENT_MAX_PAGES}, capped by budget/2)
  --budget <n>    Total page budget across both endpoints (default: ${DEFAULT_BUDGET})
  --json          Machine-readable JSON on stdout
  --help          Show this message

Exit codes: 0 identical, 1 differences, 2 errors.
`.trim();

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function flagBool(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function flagInt(name: string, fallback: number, min: number, max: number): number {
  const raw = flag(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    console.error(`[rpc-compare] --${name}: expected an integer, got "${raw}"`);
    process.exit(2);
  }
  if (parsed < min || parsed > max) {
    console.error(`[rpc-compare] --${name}: must be between ${min} and ${max}, got ${parsed}`);
    process.exit(2);
  }
  return parsed;
}

async function main(): Promise<number> {
  if (flagBool("help") || flagBool("h")) {
    console.log(HELP_TEXT);
    return 0;
  }

  const rpcA = flag("rpc-a");
  const rpcB = flag("rpc-b");
  const contractId = flag("contract");
  const fromLedger = flag("from") === undefined ? undefined : Number(flag("from"));
  const toLedger = flag("to") === undefined ? undefined : Number(flag("to"));
  const pages = flagInt("pages", EVENT_MAX_PAGES, 1, 1000);
  const budget = flagInt("budget", DEFAULT_BUDGET, 2, 10000);
  const asJson = flagBool("json");

  let fromValid: number | undefined;
  let toValid: number | undefined;
  if (fromLedger !== undefined) {
    if (!Number.isFinite(fromLedger) || !Number.isInteger(fromLedger) || fromLedger < 1) {
      console.error(`[rpc-compare] --from must be a positive integer, got "${flag("from")}"`);
      return 2;
    }
    fromValid = fromLedger;
  }
  if (toLedger !== undefined) {
    if (!Number.isFinite(toLedger) || !Number.isInteger(toLedger) || toLedger < 1) {
      console.error(`[rpc-compare] --to must be a positive integer, got "${flag("to")}"`);
      return 2;
    }
    toValid = toLedger;
  }

  if (!rpcA || !rpcB || !contractId) {
    console.error("[rpc-compare] --rpc-a, --rpc-b, and --contract are required");
    console.error(`Run with --help for usage.`);
    return 2;
  }

  const result = await compareEndpoints({
    rpcA,
    rpcB,
    contractId,
    fromLedger: fromValid,
    toLedger: toValid,
    pages,
    budget,
    json: asJson,
  });

  if (asJson) {
    process.stdout.write(formatCompareJson(result));
  } else {
    process.stdout.write(formatCompareResult(result));
  }

  return result.exitCode;
}

// Only when executed directly, not when imported by tests.
const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error(`[rpc-compare] ${boundedError(err)}`);
      process.exitCode = 2;
    });
}
