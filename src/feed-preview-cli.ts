/**
 * Offline feed preview CLI (`npm run feed:preview`).
 *
 * Reads a validated local event archive directory (`events-*.jsonl`), a
 * captured `.jsonl` event file, or a `mimir-scan-v1` JSON report file and
 * renders an Atom 1.0 or JSON Feed 1.1 document without requiring `BOT_TOKEN`
 * or making any live network requests.
 */

import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { DEFAULT_LOCALE, normalizeLocale, SUPPORTED_LOCALES, type Locale } from "./i18n.js";
import type { StellarConfig, StellarNetwork } from "./config.js";
import {
  dedupeEvents,
  sortEvents,
  type ContractSource,
  type DecodedEvent,
} from "./stellar/decode.js";
import {
  buildAtomFeed,
  buildJsonFeed,
  safeHttpsUrl,
} from "./stellar/feed.js";
import { reviveScanReport, ScanReviverError } from "./stellar/scan-reviver.js";

export type FeedPreviewFormat = "atom" | "json";

export interface ValidatedArchiveResult {
  events: DecodedEvent[];
  networkPassphrase?: string;
}

export interface FeedPreviewCliOptions {
  archivePath: string;
  format?: FeedPreviewFormat;
  outFile?: string;
  title?: string;
  selfUrl?: string;
  subtitle?: string;
  updatedAt?: string;
  explorerBaseUrl?: string;
  mimirAppUrl?: string;
  network?: Exclude<StellarNetwork, "custom">;
  locale?: string;
  limit?: number;
}

export interface FeedPreviewIo {
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
}

/** Known bigint fields per decoded event payload name. */
const ARCHIVE_BIGINT_FIELDS: Record<string, readonly string[]> = {
  claim_challenged: ["stake"],
  market_settled: ["totalPaid", "totalFees", "owedToChallengers", "dust"],
  challenger_paid: ["stake", "gross", "fee", "net"],
  fee_claimed: ["amount"],
  withdrawal: ["amount"],
  withdrawal_pending: ["amount"],
  deposited: ["amount", "shares"],
  withdrawn: ["amount"],
  resolved: ["poolA", "poolB"],
  claimed: ["gross", "fee", "net"],
  fees_claimed: ["amount"],
  fee_accrued: ["amount"],
};

const OFFLINE_NETWORK_CONFIG: Record<
  Exclude<StellarNetwork, "custom">,
  { passphrase: string; explorerBaseUrl: string; rpcUrl: string; horizonUrl: string }
> = {
  testnet: {
    passphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
  },
  mainnet: {
    passphrase: "Public Global Stellar Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer",
    rpcUrl: "https://mainnet.sorobanrpc.com",
    horizonUrl: "https://horizon.stellar.org",
  },
  futurenet: {
    passphrase: "Test SDF Future Network ; October 2022",
    explorerBaseUrl: "https://stellar.expert/explorer",
    rpcUrl: "https://rpc-futurenet.stellar.org",
    horizonUrl: "https://horizon-futurenet.stellar.org",
  },
};

const PLACEHOLDER_MARKET_CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB";
const PLACEHOLDER_SQUAD_CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC";
const DEFAULT_PREVIEW_LIMIT = 50;
const MAX_PREVIEW_LIMIT = 500;

/** Raised when an archive file or captured event record fails schema validation. */
export class FeedArchiveValidationError extends Error {
  readonly issues: readonly string[];

  constructor(message: string, issues: readonly string[] = [message]) {
    super(message);
    this.name = "FeedArchiveValidationError";
    this.issues = issues;
  }
}

function parseStrictBigInt(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return BigInt(value);
  }
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    try {
      return BigInt(value.trim());
    } catch {
      return null;
    }
  }
  return null;
}

function validateAndReviveCapturedEvent(
  raw: unknown,
  location: string,
  fallbackMeta?: { source?: ContractSource; contractId?: string; version?: string },
): DecodedEvent {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new FeedArchiveValidationError(`${location}: event record must be a JSON object`);
  }

  const obj = raw as Record<string, unknown>;
  const source = (obj.source ?? fallbackMeta?.source) as unknown;
  if (source !== "market" && source !== "squad") {
    throw new FeedArchiveValidationError(
      `${location}: invalid or missing event source (expected "market" or "squad")`,
    );
  }

  const contractId = obj.contractId ?? fallbackMeta?.contractId;
  if (typeof contractId !== "string" || contractId.trim().length === 0) {
    throw new FeedArchiveValidationError(`${location}: missing or invalid contractId`);
  }

  if (typeof obj.ledger !== "number" || !Number.isInteger(obj.ledger) || obj.ledger < 0) {
    throw new FeedArchiveValidationError(`${location}: ledger must be a non-negative integer`);
  }

  if (typeof obj.txHash !== "string") {
    throw new FeedArchiveValidationError(`${location}: txHash must be a string`);
  }

  if (typeof obj.eventId !== "string" || obj.eventId.trim().length === 0) {
    throw new FeedArchiveValidationError(`${location}: missing or invalid eventId`);
  }

  let at = 0;
  if (obj.at !== undefined) {
    if (typeof obj.at !== "number" || !Number.isFinite(obj.at) || obj.at < 0) {
      throw new FeedArchiveValidationError(`${location}: at must be a non-negative finite number`);
    }
    at = obj.at;
  } else if (typeof obj.blockTime === "number" && Number.isFinite(obj.blockTime) && obj.blockTime >= 0) {
    at = obj.blockTime;
  }

  if (!obj.payload || typeof obj.payload !== "object" || Array.isArray(obj.payload)) {
    throw new FeedArchiveValidationError(`${location}: payload must be a JSON object`);
  }

  const payloadObj = obj.payload as Record<string, unknown>;
  if (typeof payloadObj.name !== "string" || payloadObj.name.trim().length === 0) {
    throw new FeedArchiveValidationError(`${location}: payload.name must be a non-empty string`);
  }

  const revivedPayload: Record<string, unknown> = { ...payloadObj };
  const bigintFields = ARCHIVE_BIGINT_FIELDS[payloadObj.name];
  if (bigintFields) {
    for (const field of bigintFields) {
      if (field in revivedPayload && revivedPayload[field] !== undefined) {
        const parsed = parseStrictBigInt(revivedPayload[field]);
        if (parsed === null) {
          throw new FeedArchiveValidationError(
            `${location}: payload.${field} must be an integer string or bigint`,
          );
        }
        revivedPayload[field] = parsed;
      }
    }
  }

  const rawTxIndex = obj.transactionIndex ?? obj.txIndex ?? null;
  if (rawTxIndex !== null && (typeof rawTxIndex !== "number" || !Number.isInteger(rawTxIndex) || rawTxIndex < 0)) {
    throw new FeedArchiveValidationError(`${location}: transactionIndex must be null or non-negative integer`);
  }

  const rawOpIndex = obj.operationIndex ?? null;
  if (rawOpIndex !== null && (typeof rawOpIndex !== "number" || !Number.isInteger(rawOpIndex) || rawOpIndex < 0)) {
    throw new FeedArchiveValidationError(`${location}: operationIndex must be null or non-negative integer`);
  }

  const version =
    typeof obj.version === "string" && obj.version.trim().length > 0
      ? obj.version.trim()
      : (fallbackMeta?.version ?? "v1");

  const eventType =
    typeof obj.eventType === "string" && obj.eventType.trim().length > 0
      ? obj.eventType
      : "contract";

  const inSuccessfulContractCall =
    typeof obj.inSuccessfulContractCall === "boolean" ? obj.inSuccessfulContractCall : true;

  return {
    source,
    contractId: contractId.trim(),
    version,
    ledger: obj.ledger,
    txHash: obj.txHash,
    at,
    eventId: obj.eventId.trim(),
    eventType,
    transactionIndex: rawTxIndex,
    operationIndex: rawOpIndex,
    inSuccessfulContractCall,
    payload: revivedPayload as unknown as DecodedEvent["payload"],
  };
}

function parseJsonlEvents(content: string, fileLabel: string): DecodedEvent[] {
  const lines = content.split("\n");
  const events: DecodedEvent[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = (lines[i] ?? "").trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new FeedArchiveValidationError(
        `${fileLabel}:${i + 1}: invalid JSON (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    events.push(validateAndReviveCapturedEvent(parsed, `${fileLabel}:${i + 1}`));
  }
  return events;
}

/**
 * Read and strictly validate captured events from an archive directory
 * (`events-*.jsonl`), a `.jsonl` file, or a `mimir-scan-v1` `.json` report.
 *
 * Performs local filesystem reads only — no network calls or bot credentials.
 */
export async function readValidatedEventArchive(archivePath: string): Promise<ValidatedArchiveResult> {
  if (!archivePath || archivePath.trim().length === 0) {
    throw new FeedArchiveValidationError("Archive path is required (--archive <dir-or-file>)");
  }

  let info;
  try {
    info = await stat(archivePath);
  } catch {
    throw new FeedArchiveValidationError(`Archive path not found or unreadable: ${archivePath}`);
  }

  if (info.isDirectory()) {
    const entries = await readdir(archivePath);
    const archiveFiles = entries
      .filter((name) => name.startsWith("events-") && name.endsWith(".jsonl"))
      .sort();

    if (archiveFiles.length === 0) {
      throw new FeedArchiveValidationError(
        `No validated archive files (events-*.jsonl) found in directory: ${archivePath}`,
      );
    }

    const events: DecodedEvent[] = [];
    for (const file of archiveFiles) {
      const fullPath = path.join(archivePath, file);
      const content = await readFile(fullPath, "utf8");
      events.push(...parseJsonlEvents(content, file));
    }

    return { events: sortEvents(dedupeEvents(events)) };
  }

  if (!info.isFile()) {
    throw new FeedArchiveValidationError(`Unsupported archive path type: ${archivePath}`);
  }

  const raw = await readFile(archivePath, "utf8");
  const lower = archivePath.toLowerCase();

  if (lower.endsWith(".jsonl")) {
    const events = parseJsonlEvents(raw, path.basename(archivePath));
    return { events: sortEvents(dedupeEvents(events)) };
  }

  // Try mimir-scan-v1 JSON report
  let report;
  try {
    report = reviveScanReport(raw);
  } catch (err) {
    if (err instanceof ScanReviverError) {
      throw new FeedArchiveValidationError(`Invalid scan archive (${path.basename(archivePath)}): ${err.message}`);
    }
    throw err;
  }

  const events: DecodedEvent[] = [];
  for (let tIdx = 0; tIdx < report.targets.length; tIdx += 1) {
    const target = report.targets[tIdx];
    if (!target || typeof target !== "object" || !Array.isArray(target.events)) {
      throw new FeedArchiveValidationError(
        `${path.basename(archivePath)}: target[${tIdx}] is missing an events array`,
      );
    }
    if (target.source !== "market" && target.source !== "squad") {
      throw new FeedArchiveValidationError(
        `${path.basename(archivePath)}: target[${tIdx}] has invalid source "${String(target.source)}"`,
      );
    }
    if (typeof target.contractId !== "string" || target.contractId.trim().length === 0) {
      throw new FeedArchiveValidationError(
        `${path.basename(archivePath)}: target[${tIdx}] is missing contractId`,
      );
    }
    const rawVersion = (target as { version?: unknown }).version;
    for (let eIdx = 0; eIdx < target.events.length; eIdx += 1) {
      events.push(
        validateAndReviveCapturedEvent(
          target.events[eIdx],
          `${path.basename(archivePath)}:target[${tIdx}].events[${eIdx}]`,
          {
            source: target.source,
            contractId: target.contractId,
            version: typeof rawVersion === "string" ? rawVersion : "v1",
          },
        ),
      );
    }
  }

  return {
    events: sortEvents(dedupeEvents(events)),
    networkPassphrase: report.network,
  };
}

function inferNetworkFromPassphrase(passphrase?: string): Exclude<StellarNetwork, "custom"> {
  if (passphrase === OFFLINE_NETWORK_CONFIG.mainnet.passphrase) return "mainnet";
  if (passphrase === OFFLINE_NETWORK_CONFIG.futurenet.passphrase) return "futurenet";
  return "testnet";
}

function buildOfflineStellarConfig(
  events: readonly DecodedEvent[],
  options: FeedPreviewCliOptions,
  archiveNetworkPassphrase?: string,
): StellarConfig {
  const network = options.network ?? inferNetworkFromPassphrase(archiveNetworkPassphrase);
  const defaults = OFFLINE_NETWORK_CONFIG[network];

  let explorerBaseUrl = defaults.explorerBaseUrl;
  if (options.explorerBaseUrl !== undefined) {
    const safeExplorer = safeHttpsUrl(options.explorerBaseUrl);
    if (safeExplorer === null) {
      throw new FeedArchiveValidationError(
        `Invalid --explorer-base-url (must be an https:// URL): ${options.explorerBaseUrl}`,
      );
    }
    explorerBaseUrl = safeExplorer.replace(/\/+$/, "");
  }

  const marketEvent = events.find((e) => e.source === "market");
  const squadEvent = events.find((e) => e.source === "squad");

  let locale: Locale = DEFAULT_LOCALE;
  if (options.locale !== undefined) {
    const parsedLocale = normalizeLocale(options.locale);
    if (parsedLocale === null) {
      throw new FeedArchiveValidationError(
        `Unsupported --locale "${options.locale}" (supported: ${SUPPORTED_LOCALES.join(", ")})`,
      );
    }
    locale = parsedLocale;
  }

  return {
    network,
    locale,
    marketContractId: marketEvent?.contractId ?? PLACEHOLDER_MARKET_CONTRACT,
    squadContractId: squadEvent?.contractId ?? PLACEHOLDER_SQUAD_CONTRACT,
    marketContractVersion: marketEvent?.version ?? "v1",
    squadContractVersion: squadEvent?.version ?? "v1",
    rpcUrl: defaults.rpcUrl,
    horizonUrl: defaults.horizonUrl,
    networkPassphrase: archiveNetworkPassphrase ?? defaults.passphrase,
    explorerBaseUrl,
  };
}

/**
 * Render an Atom 1.0 or JSON Feed 1.1 preview string offline from a validated archive.
 */
export async function renderOfflineFeedPreview(options: FeedPreviewCliOptions): Promise<string> {
  const format = options.format ?? "atom";
  if (format !== "atom" && format !== "json") {
    throw new FeedArchiveValidationError(
      `Unsupported feed format "${String(format)}" (expected "atom" or "json")`,
    );
  }

  const rawLimit = options.limit ?? DEFAULT_PREVIEW_LIMIT;
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > MAX_PREVIEW_LIMIT) {
    throw new FeedArchiveValidationError(
      `--limit must be an integer between 1 and ${MAX_PREVIEW_LIMIT}, got ${String(rawLimit)}`,
    );
  }

  const defaultSelfUrl =
    format === "json" ? "https://mimir.local/feed.json" : "https://mimir.local/feed.atom";
  const selfUrl = options.selfUrl ?? defaultSelfUrl;
  if (safeHttpsUrl(selfUrl) === null) {
    throw new FeedArchiveValidationError(
      `Invalid --self-url (must be an https:// URL): ${selfUrl}`,
    );
  }

  if (options.mimirAppUrl !== undefined && safeHttpsUrl(options.mimirAppUrl) === null) {
    throw new FeedArchiveValidationError(
      `Invalid --mimir-app-url (must be an https:// URL): ${options.mimirAppUrl}`,
    );
  }

  const { events, networkPassphrase } = await readValidatedEventArchive(options.archivePath);
  const boundedEvents = events.length > rawLimit ? events.slice(-rawLimit) : events;
  const config = buildOfflineStellarConfig(boundedEvents, options, networkPassphrase);

  const maxAt = boundedEvents.reduce((best, e) => Math.max(best, e.at ?? 0), 0);
  const updatedAt =
    options.updatedAt ??
    (maxAt > 0 ? new Date(maxAt * 1000).toISOString() : new Date(0).toISOString());

  const feedOptions = {
    title: options.title ?? "Mimir Events",
    selfUrl,
    config,
    updatedAt,
    subtitle: options.subtitle,
    mimirAppUrl: options.mimirAppUrl ?? null,
  };

  if (format === "json") {
    return `${buildJsonFeed(boundedEvents, feedOptions).trimEnd()}\n`;
  }
  return `${buildAtomFeed(boundedEvents, feedOptions)}\n`;
}

function usage(): string {
  return [
    "Usage: npm run feed:preview -- --archive <dir-or-file> [options]",
    "",
    "Render an offline Atom 1.0 or JSON Feed 1.1 preview from captured events.",
    "Requires no BOT_TOKEN and performs no live network requests.",
    "",
    "Options:",
    "  --archive, --input <path>      Event archive directory (events-*.jsonl), .jsonl, or mimir-scan-v1 .json",
    "  --format <atom|json>           Output format (default: atom)",
    "  --out <file>                   Write output to file instead of stdout",
    "  --title <text>                 Feed title (default: Mimir Events)",
    "  --self-url <https-url>         Canonical feed self URL",
    "  --subtitle <text>              Optional feed subtitle / description",
    "  --updated-at <iso8601>         Override feed <updated> timestamp",
    "  --explorer-base-url <https>    Explorer base URL override",
    "  --mimir-app-url <https>        Optional Mimir web-app base URL for deep links",
    "  --network <testnet|mainnet|futurenet> Network preset (default: inferred or testnet)",
    "  --locale <code >               Locale for plain-text rendering (default: en)",
    "  --limit <1..500>               Maximum events to include (default: 50)",
    "  --help                         Show this message",
  ].join("\n");
}

function parseArgs(argv: readonly string[]): { help: true } | { help: false; options: FeedPreviewCliOptions } {
  if (argv.includes("--help") || argv.includes("-h")) {
    return { help: true };
  }

  let archivePath: string | undefined;
  let format: FeedPreviewFormat | undefined;
  let outFile: string | undefined;
  let title: string | undefined;
  let selfUrl: string | undefined;
  let subtitle: string | undefined;
  let updatedAt: string | undefined;
  let explorerBaseUrl: string | undefined;
  let mimirAppUrl: string | undefined;
  let network: Exclude<StellarNetwork, "custom"> | undefined;
  let locale: string | undefined;
  let limit: number | undefined;

  const takeValue = (flagName: string, idx: number): string => {
    const val = argv[idx + 1];
    if (val === undefined || val.startsWith("--")) {
      throw new FeedArchiveValidationError(`Missing value for ${flagName}`);
    }
    return val;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--archive" || arg === "--input") {
      archivePath = takeValue(arg, i);
      i += 1;
    } else if (arg === "--format") {
      const rawFmt = takeValue(arg, i).trim().toLowerCase();
      if (rawFmt !== "atom" && rawFmt !== "json") {
        throw new FeedArchiveValidationError(
          `Unsupported --format "${rawFmt}" (expected "atom" or "json")`,
        );
      }
      format = rawFmt;
      i += 1;
    } else if (arg === "--out") {
      outFile = takeValue(arg, i);
      i += 1;
    } else if (arg === "--title") {
      title = takeValue(arg, i);
      i += 1;
    } else if (arg === "--self-url") {
      selfUrl = takeValue(arg, i);
      i += 1;
    } else if (arg === "--subtitle") {
      subtitle = takeValue(arg, i);
      i += 1;
    } else if (arg === "--updated-at") {
      updatedAt = takeValue(arg, i);
      i += 1;
    } else if (arg === "--explorer-base-url") {
      explorerBaseUrl = takeValue(arg, i);
      i += 1;
    } else if (arg === "--mimir-app-url") {
      mimirAppUrl = takeValue(arg, i);
      i += 1;
    } else if (arg === "--network") {
      const rawNet = takeValue(arg, i).trim().toLowerCase();
      if (rawNet !== "testnet" && rawNet !== "mainnet" && rawNet !== "futurenet") {
        throw new FeedArchiveValidationError(
          `Unsupported --network "${rawNet}" (expected "testnet", "mainnet", or "futurenet")`,
        );
      }
      network = rawNet;
      i += 1;
    } else if (arg === "--locale") {
      locale = takeValue(arg, i);
      i += 1;
    } else if (arg === "--limit") {
      const rawLim = Number(takeValue(arg, i));
      if (!Number.isInteger(rawLim)) {
        throw new FeedArchiveValidationError("--limit must be an integer");
      }
      limit = rawLim;
      i += 1;
    } else if (arg.startsWith("-")) {
      throw new FeedArchiveValidationError(`Unknown flag: ${arg}`);
    } else if (archivePath === undefined) {
      archivePath = arg;
    } else {
      throw new FeedArchiveValidationError(`Unexpected positional argument: ${arg}`);
    }
  }

  if (!archivePath) {
    throw new FeedArchiveValidationError("Missing required --archive <dir-or-file> argument");
  }

  return {
    help: false,
    options: {
      archivePath,
      format,
      outFile,
      title,
      selfUrl,
      subtitle,
      updatedAt,
      explorerBaseUrl,
      mimirAppUrl,
      network,
      locale,
      limit,
    },
  };
}

/**
 * Execute the offline feed preview CLI and return an exit status (`0` or `1`).
 */
export async function runFeedPreviewCli(
  argv: readonly string[] = process.argv.slice(2),
  io: FeedPreviewIo = {
    stdout: (chunk) => process.stdout.write(chunk),
    stderr: (chunk) => process.stderr.write(chunk),
  },
): Promise<number> {
  try {
    const parsed = parseArgs(argv);
    if (parsed.help) {
      io.stdout(`${usage()}\n`);
      return 0;
    }

    const rendered = await renderOfflineFeedPreview(parsed.options);
    if (parsed.options.outFile) {
      await mkdir(path.dirname(path.resolve(parsed.options.outFile)), { recursive: true });
      await writeFile(parsed.options.outFile, rendered, "utf8");
    } else {
      io.stdout(rendered);
    }
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    io.stderr(`[feed:preview] ${msg}\n`);
    return 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  runFeedPreviewCli().then((code) => {
    process.exitCode = code;
  });
}
