/**
 * Soroban RPC client construction and Stellar explorer URL helpers.
 *
 * `getEvents` is the only endpoint this bot needs, and it is unauthenticated on
 * the public Testnet RPC — there is no key to configure here.
 *
 * Explorer links are centralized here so notifications, logs, and CLI helpers
 * share one construction path (network segment + optional base override).
 *
 * Ledger-window validation lives here too: the client is the one place that
 * knows the RPC contract, so the bounds an `getEvents` request must respect
 * (retained floor, chain tip) are checked before a request is spent on them.
 */

import { rpc } from "@stellar/stellar-sdk";

import type { StellarConfig } from "../config.js";
import { MOCK_NETWORK_PASSPHRASE } from "./mock-constants.js";
import {
  DEFAULT_MAX_RPC_REDIRECTS,
  RpcEgressError,
  assertRpcEgressAllowed,
  isLoopbackHostname,
  normalizeRpcAllowlistEntry,
  parseRpcAllowlist,
  type AssertRpcEgressOptions,
  type RpcEgressPhase,
  type RpcEgressProblem,
} from "./rpc-guard.js";

export {
  DEFAULT_MAX_RPC_REDIRECTS,
  RpcEgressError,
  assertRpcEgressAllowed,
  isLoopbackHostname,
  normalizeRpcAllowlistEntry,
  parseRpcAllowlist,
  type AssertRpcEgressOptions,
  type RpcEgressPhase,
  type RpcEgressProblem,
};

export class RpcPassphraseError extends Error {
  constructor(expected: string, actual: string) {
    super(
      `RPC network passphrase mismatch: expected "${expected}" but RPC reported "${actual}". ` +
      `Check STELLAR_RPC_URL and STELLAR_NETWORK_PASSPHRASE configuration.`,
    );
    this.name = "RpcPassphraseError";
  }
}

export interface RpcServerGuardOptions {
  /** Override egress allowlist entries (defaults to `config.rpcAllowlist`). */
  allowlist?: readonly string[] | undefined;
  /** Override mock-mode loopback exception flag (defaults to `config.mockMode` or mock passphrase). */
  mockMode?: boolean | undefined;
  /** Maximum HTTP redirect hops permitted (defaults to {@link DEFAULT_MAX_RPC_REDIRECTS}). */
  maxRedirects?: number | undefined;
  /** Injectable fetch implementation for hermetic tests. */
  fetchImpl?: typeof globalThis.fetch | undefined;
}

interface SdkHttpAdapterConfig {
  url?: string;
  baseURL?: string;
  method?: string;
  headers?: RequestInit["headers"];
  params?: Record<string, string>;
  data?: unknown;
  timeout?: number;
  signal?: AbortSignal;
  fetchOptions?: RequestInit;
}

interface SdkHttpAdapterResponse {
  data: unknown;
  headers: Headers;
  config: SdkHttpAdapterConfig;
  status: number;
  statusText: string;
}

function buildAdapterUrl(config: SdkHttpAdapterConfig, fallbackUrl: string): string {
  let url = config.url || fallbackUrl;
  if (config.baseURL && url && !/^https?:\/\//i.test(url)) {
    url = url.replace(/^\/?/, `${config.baseURL.replace(/\/$/, "")}/`);
  }
  if (config.params && Object.keys(config.params).length > 0) {
    const qs = new URLSearchParams(config.params).toString();
    url += (url.includes("?") ? "&" : "?") + qs;
  }
  return url;
}

function encodeAdapterBody(data: unknown, headers: Headers): RequestInit["body"] {
  if (data === undefined || data === null) return undefined;
  if (typeof data === "string") return data;
  if (data instanceof URLSearchParams) {
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/x-www-form-urlencoded");
    }
    return data;
  }
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return JSON.stringify(data);
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Create a `@stellar/stellar-sdk` HTTP client adapter that enforces operator
 * RPC egress allowlists across both initial URLs and manual HTTP redirect hops.
 */
export function createEgressGuardedRpcAdapter(options: {
  rpcUrl: string;
  allowlist?: readonly string[] | undefined;
  mockMode?: boolean | undefined;
  maxRedirects?: number | undefined;
  defaultTimeoutMs?: number | undefined;
  fetchImpl?: typeof globalThis.fetch | undefined;
}): (reqConfig: SdkHttpAdapterConfig) => Promise<SdkHttpAdapterResponse> {
  const fetchFn = options.fetchImpl ?? globalThis.fetch;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_RPC_REDIRECTS;
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 15_000;
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 10) {
    throw new RangeError(`maxRedirects must be an integer between 0 and 10; got ${maxRedirects}`);
  }

  return async (reqConfig: SdkHttpAdapterConfig): Promise<SdkHttpAdapterResponse> => {
    let currentUrl = buildAdapterUrl(reqConfig, options.rpcUrl);
    assertRpcEgressAllowed(currentUrl, {
      allowlist: options.allowlist,
      mockMode: options.mockMode,
      phase: "initial",
    });

    let currentHeaders = new Headers(reqConfig.headers ?? {});
    let currentMethod = (reqConfig.method ?? "POST").toUpperCase();
    let currentBody = encodeAdapterBody(reqConfig.data, currentHeaders);

    const signals: AbortSignal[] = [];
    const effectiveTimeout = reqConfig.timeout ?? defaultTimeoutMs;
    if (effectiveTimeout > 0) {
      signals.push(AbortSignal.timeout(effectiveTimeout));
    }
    if (reqConfig.signal) {
      signals.push(reqConfig.signal);
    }
    const signal =
      signals.length === 0
        ? undefined
        : signals.length === 1
          ? signals[0]!
          : AbortSignal.any(signals);

    let hops = 0;
    let response: Response;

    while (true) {
      try {
        response = await fetchFn(currentUrl, {
          ...reqConfig.fetchOptions,
          method: currentMethod,
          headers: currentHeaders,
          body: currentBody,
          redirect: "manual",
          ...(signal ? { signal } : {}),
        });
      } catch (err) {
        if (err instanceof RpcEgressError) throw err;
        if ((err as { name?: string } | null)?.name === "TimeoutError") {
          throw new Error(`timeout of ${effectiveTimeout}ms exceeded`);
        }
        throw err;
      }

      if (!REDIRECT_STATUSES.has(response.status)) {
        break;
      }

      if (response.body) {
        await response.body.cancel().catch(() => {});
      }

      if (hops >= maxRedirects) {
        throw new RpcEgressError(
          "too-many-redirects",
          "redirect",
          `RPC redirect chain exceeded maximum of ${maxRedirects} hop(s)`,
        );
      }

      const location = response.headers.get("location");
      if (!location || location.trim() === "") {
        throw new RpcEgressError(
          "redirect-missing-location",
          "redirect",
          `RPC HTTP ${response.status} redirect omitted Location header`,
        );
      }

      let resolvedNextUrl: string;
      try {
        resolvedNextUrl = new URL(location.trim(), currentUrl).toString();
      } catch {
        throw new RpcEgressError(
          "invalid-url",
          "redirect",
          "RPC redirect Location header is not a valid URL",
        );
      }

      const validatedNext = assertRpcEgressAllowed(resolvedNextUrl, {
        allowlist: options.allowlist,
        mockMode: options.mockMode,
        phase: "redirect",
      });

      const prevOrigin = new URL(currentUrl).origin.toLowerCase();
      if (validatedNext.origin.toLowerCase() !== prevOrigin) {
        currentHeaders = new Headers(currentHeaders);
        currentHeaders.delete("authorization");
        currentHeaders.delete("proxy-authorization");
        currentHeaders.delete("cookie");
      }

      if (response.status !== 307 && response.status !== 308) {
        currentMethod = "GET";
        currentBody = undefined;
        currentHeaders = new Headers(currentHeaders);
        currentHeaders.delete("content-type");
        currentHeaders.delete("content-length");
        currentHeaders.delete("transfer-encoding");
      }

      currentUrl = validatedNext.toString();
      hops += 1;
    }

    const text = await response.text();
    let data: unknown = text;
    if (text.length > 0) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    if (!response.ok) {
      const httpErr = new Error(`Request failed with status code ${response.status}`) as Error & {
        response?: SdkHttpAdapterResponse;
      };
      httpErr.response = {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        data,
        config: reqConfig,
      };
      throw httpErr;
    }

    return {
      data,
      headers: response.headers,
      config: reqConfig,
      status: response.status,
      statusText: response.statusText,
    };
  };
}

/**
 * Create an RPC server. Construction validates egress policy offline; the
 * network passphrase is verified separately at boot by {@link validateNetworkPassphrase}.
 */
export function createRpcServer(
  config: StellarConfig,
  options: RpcServerGuardOptions = {},
): rpc.Server {
  const allowlist = options.allowlist ?? config.rpcAllowlist;
  const mockMode =
    options.mockMode ??
    config.mockMode ??
    config.networkPassphrase === MOCK_NETWORK_PASSPHRASE;

  const validatedInitial = assertRpcEgressAllowed(config.rpcUrl, {
    allowlist,
    mockMode,
    phase: "initial",
  });

  const server = new rpc.Server(config.rpcUrl, {
    // Only relevant for a local quickstart container on plain http.
    allowHttp: validatedInitial.protocol === "http:",
    timeout: 15000,
  });

  const clientDefaults = (
    server as unknown as {
      httpClient?: { defaults?: { adapter?: unknown; timeout?: number } };
    }
  ).httpClient?.defaults;

  if (clientDefaults) {
    clientDefaults.timeout = 15_000;
    clientDefaults.adapter = createEgressGuardedRpcAdapter({
      rpcUrl: config.rpcUrl,
      allowlist,
      mockMode,
      maxRedirects: options.maxRedirects,
      defaultTimeoutMs: 15_000,
      fetchImpl: options.fetchImpl,
    });
  }

  return server;
}

/** Default stellar.expert origin; override with STELLAR_EXPLORER_BASE_URL. */
export const DEFAULT_EXPLORER_BASE_URL = "https://stellar.expert/explorer";

/**
 * Resolve the explorer network path segment from the configured network name.
 * `futurenet` and `custom` fall back to `testnet` so links remain usable in
 * local and non-standard deployments. Falls back to passphrase inference when
 * the `network` field is absent (e.g. in tests that predate multi-network support).
 */
export function explorerNetworkSegment(config: StellarConfig): "public" | "testnet" {
  const net = config.network ?? inferFromPassphrase(config.networkPassphrase);
  return net === "mainnet" ? "public" : "testnet";
}

function inferFromPassphrase(passphrase: string): string {
  if (passphrase === "Public Global Stellar Network ; September 2015") return "mainnet";
  return "testnet";
}

function explorerBase(config: StellarConfig): string {
  const raw = (config.explorerBaseUrl || DEFAULT_EXPLORER_BASE_URL).replace(/\/+$/, "");
  return raw;
}

function explorerPart(value: string): string {
  return encodeURIComponent(value.trim());
}

/** Explorer link for a transaction hash, used in notification footers. */
export function txExplorerUrl(config: StellarConfig, txHash: string): string {
  // Callers that link events validate the full 64-hex shape themselves (see
  // `eventExplorerUrl`); here only a bounded token that cannot break the URL
  // path is accepted.
  const hash = txHash.trim();
  if (!hash || !/^[A-Za-z0-9]{1,128}$/.test(hash)) return "";
  const network = explorerNetworkSegment(config);
  return `${explorerBase(config)}/${network}/tx/${explorerPart(hash)}`;
}

/** Explorer link for a classic / contract account. */
export function accountExplorerUrl(config: StellarConfig, address: string): string {
  const id = address.trim();
  if (!id || !/^[GC][A-Z2-7]{55}$/.test(id)) return "";
  const network = explorerNetworkSegment(config);
  return `${explorerBase(config)}/${network}/account/${explorerPart(id)}`;
}

/** Explorer link for a Soroban contract id, used by /contracts. */
export function contractExplorerUrl(config: StellarConfig, contractId: string): string {
  const id = contractId.trim();
  if (!id || !/^C[A-Z2-7]{55}$/.test(id)) return "";
  const network = explorerNetworkSegment(config);
  return `${explorerBase(config)}/${network}/contract/${explorerPart(id)}`;
}

// ── Ledger-window bounds ─────────────────────────────────────────────────────
//
// `getEvents` only serves a rolling window of history. `getHealth()` reports it:
//
//   oldestLedger  the retained floor — anything earlier is an ERROR, not a gap
//   latestLedger  the chain tip     — anything later is an ERROR, not a gap
//
// The real RPC rejects both, and so does `src/stellar/mock-rpc.ts`. Refusing
// them here instead means the failure is a bounded, deterministic, secret-free
// error that names the bound — never an opaque remote payload copied into a log
// — and that no request is spent on a range the window already proves invalid.

/** The retained event window reported by `getHealth()`. */
export interface LedgerWindow {
  /** Oldest ledger the RPC still retains. Requests below it are errors. */
  oldestLedger: number;
  /** Current chain tip. Requests above it are errors. */
  latestLedger: number;
}

/** Why a ledger window, start ledger, or resume cursor cannot be scanned. */
export type LedgerWindowProblem =
  | "malformed-window"
  | "start-invalid"
  | "start-after-tip"
  | "cursor-after-tip";

/** Why the RPC network passphrase cannot be verified. */
export type NetworkPassphraseProblem = "mismatch" | "missing" | "malformed";

/**
 * Raised when the RPC's reported network passphrase does not match the
 * configured value. This is a safety-critical misconfiguration: either the
 * RPC is pointed at the wrong network, or the configuration itself is wrong.
 *
 * The error message is bounded and never contains the actual passphrases,
 * so it can be surfaced in logs and status output without leaking secrets.
 */
export class NetworkPassphraseMismatchError extends Error {
  readonly problem: NetworkPassphraseProblem;

  constructor(problem: NetworkPassphraseProblem, message: string) {
    super(message);
    this.name = "NetworkPassphraseMismatchError";
    this.problem = problem;
  }
}

/** Render a remote error without echoing an unbounded payload. */
function boundedRemoteError(err: unknown): string {
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : String(err || "unknown error");
  const bounded = msg.replace(/\s+/g, " ").trim();
  return bounded.length <= 100 ? bounded : `${bounded.slice(0, 99)}…`;
}

/**
 * Verify that the RPC reports the configured network passphrase. Fails fast at
 * boot so the notifier never reads events from the wrong network. The error
 * never contains either passphrase, only their lengths.
 *
 * @param server The Soroban RPC server (from {@link createRpcServer})
 */
export async function validateNetworkPassphrase(
  server: Pick<rpc.Server, "getNetwork">,
  config: Pick<StellarConfig, "networkPassphrase">,
): Promise<void> {
  let network: unknown;
  try {
    network = await server.getNetwork();
  } catch (err) {
    throw new NetworkPassphraseMismatchError(
      "missing",
      `getNetwork failed: ${boundedRemoteError(err)}`,
    );
  }

  const rpcPassphrase = (network as Record<string, unknown> | null)?.passphrase;
  if (typeof rpcPassphrase !== "string") {
    throw new NetworkPassphraseMismatchError(
      "malformed",
      `RPC getNetwork returned a malformed passphrase (expected a string; got ${typeof rpcPassphrase})`,
    );
  }

  if (rpcPassphrase !== config.networkPassphrase) {
    throw new NetworkPassphraseMismatchError(
      "mismatch",
      `RPC network passphrase does not match the configured value ` +
        `(configured=${config.networkPassphrase.length} chars, received=${rpcPassphrase.length} chars)`,
    );
  }
}

/**
 * Raised for a ledger-window bound that is invalid before any request is sent.
 *
 * The message is numeric and bounded by construction, so it can be surfaced in
 * `/status`, in logs, and by the scanner CLI without copying a remote payload.
 */
export class LedgerWindowError extends Error {
  readonly problem: LedgerWindowProblem;

  constructor(problem: LedgerWindowProblem, message: string) {
    super(message);
    this.name = "LedgerWindowError";
    this.problem = problem;
  }
}

// ── Contract ID validation ───────────────────────────────────────────────────
//
// Contract IDs are loaded at config time and validated there. Runtime validation
// is added as a defense-in-depth check before they're used in RPC filters, so
// a malformed ID cannot reach the RPC or corrupt the filter chain.
//
// The validation error is bounded by construction — never including raw payloads
// — so it can be safely logged, surfaced in /status, and included in audit trails.

/** Why a contract ID is invalid. */
export type ContractIdProblem = "malformed-format" | "empty-value";

/**
 * Raised when a contract ID fails validation before being sent to the RPC.
 *
 * The message is bounded by construction, so it can be surfaced in `/status`,
 * in logs, and by the scanner CLI without copying a remote payload or the
 * malformed contract ID itself.
 */
export class ContractIdError extends Error {
  readonly problem: ContractIdProblem;

  constructor(problem: ContractIdProblem, message: string) {
    super(message);
    this.name = "ContractIdError";
    this.problem = problem;
  }
}

/** Soroban contract ID format: C + 55 base32 characters (strkey). */
const CONTRACT_ID_RE = /^C[A-Z2-7]{55}$/;

/**
 * Truncate a contract ID to a safe, bounded form for logging.
 * Returns the first character and the last 4 characters: C…XXXX
 */
function truncatedContractId(contractId: string): string {
  if (typeof contractId !== "string") return "C…???";
  const trimmed = contractId.trim();
  if (trimmed.length === 0) return "C…(empty)";
  if (trimmed.length <= 5) return `${trimmed[0]}…`;
  return `${trimmed[0]}…${trimmed.slice(-4)}`;
}

/**
 * Validate a contract ID before it is used in an RPC request.
 *
 * Throws a bounded {@link ContractIdError} when the ID is empty, malformed, or
 * not a string, rather than letting it reach the RPC or corrupt the filter.
 * Used at the boundary where contract IDs enter RPC requests.
 *
 * Covered by `tests/client-validation-fuzz.test.mjs`, which fuzzes this
 * validator with a seeded generator to confirm every malformed input throws
 * a {@link ContractIdError} (never an unexpected error type).
 *
 * @param contractId - The contract ID to validate (typically from config)
 * @param field - Label used in error messages, e.g. "market contract ID"
 * @throws {ContractIdError} When the contract ID is invalid
 */
export function validateContractId(contractId: unknown, field = "contract ID"): true {
  if (typeof contractId !== "string") {
    throw new ContractIdError(
      "empty-value",
      `${field} must be a string; got ${typeof contractId}`,
    );
  }

  const trimmed = contractId.trim();
  if (trimmed === "") {
    throw new ContractIdError("empty-value", `${field} cannot be empty`);
  }

  if (!CONTRACT_ID_RE.test(trimmed)) {
    throw new ContractIdError(
      "malformed-format",
      `${field} is not a Soroban contract ID (a valid Soroban contract ID is a ` +
        `C… strkey, 56 chars); got ${truncatedContractId(trimmed)}`,
    );
  }
  return true;
}

/** A ledger sequence we are willing to put into a request. */
function isLedgerSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Render an untrusted health value without echoing an unbounded payload. */
function boundedLedgerValue(value: unknown): string {
  const text = String(value).replace(/\s+/g, " ").trim() || "missing";
  return text.length <= 32 ? text : `${text.slice(0, 31)}…`;
}

/**
 * Validate the window reported by `getHealth()`.
 *
 * Throws a bounded {@link LedgerWindowError} when the numbers are missing,
 * negative, non-integer, or inverted, rather than letting a nonsense range
 * reach the RPC.
 *
 * Covered by `tests/client-validation-fuzz.test.mjs`, which fuzzes this
 * validator with a seeded generator (including negatives and `NaN`) to
 * confirm every malformed window throws a {@link LedgerWindowError}.
 */
export function validateLedgerWindow(health: {
  oldestLedger?: unknown;
  latestLedger?: unknown;
}): LedgerWindow {
  const oldestLedger = health?.oldestLedger;
  const latestLedger = health?.latestLedger;

  if (!isLedgerSequence(oldestLedger) || !isLedgerSequence(latestLedger)) {
    throw new LedgerWindowError(
      "malformed-window",
      `getHealth reported a malformed ledger window ` +
        `(oldest=${boundedLedgerValue(oldestLedger)}, latest=${boundedLedgerValue(latestLedger)})`,
    );
  }
  if (oldestLedger > latestLedger) {
    throw new LedgerWindowError(
      "malformed-window",
      `getHealth reported an inverted ledger window ` +
        `(oldest ${oldestLedger} > latest ${latestLedger})`,
    );
  }

  return { oldestLedger, latestLedger };
}

/**
 * Put a requested start ledger inside the retained window.
 *
 * Below the floor is clamped *up*: the floor is dynamic and the events there are
 * gone, so a cold start asks for the oldest thing that still exists. Above the
 * tip is an error — silently substituting a different range would make
 * `npm run scan -- --from <future>` claim to have read ledger `<future>`.
 */
export function clampStartLedger(
  requested: number,
  window: LedgerWindow,
): { startLedger: number; clamped: boolean } {
  if (!isLedgerSequence(requested) || requested < 1) {
    throw new LedgerWindowError(
      "start-invalid",
      `startLedger must be a positive integer; got ${boundedLedgerValue(requested)}`,
    );
  }
  if (requested > window.latestLedger) {
    throw new LedgerWindowError(
      "start-after-tip",
      `startLedger ${requested} is ahead of the chain tip ${window.latestLedger}`,
    );
  }
  if (requested < window.oldestLedger) {
    return { startLedger: window.oldestLedger, clamped: true };
  }
  return { startLedger: requested, clamped: false };
}

/**
 * Generates a synthetic Soroban event fixture for testing purposes.
 *
 * This function creates a valid-looking Soroban event structure without
 * requiring actual RPC calls or signing keys. It is used to ensure the
 * read-only Mimir notifier remains reliable during long-running Stellar
 * and Telegram failures.
 *
 * @param config - The Stellar configuration object.
 * @param txHash - A mock transaction hash for the fixture.
 * @returns A synthetic Soroban event object.
 */
export function generateSyntheticEventFixture(
  config: StellarConfig,
  txHash: string = "mock-tx-hash-1234567890abcdef"
): rpc.Api.RawGetEventsResponse {
  void config;
  return {
    events: [
      {
        type: "contract",
        contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
        id: "1234567890",
        ledger: 12345678,
        ledgerClosedAt: new Date().toISOString(),
        transactionIndex: 0,
        operationIndex: 0,
        inSuccessfulContractCall: true,
        topic: ["bG9nIGV2ZW50"], // Base64 encoded "log event"
        value: "SGVsbG8gV29ybGQ=", // Base64 encoded "Hello World"
        txHash: txHash,
      },
    ],
    cursor: "",
    latestLedger: 12345678,
    oldestLedger: 12345678,
    latestLedgerCloseTime: "0",
    oldestLedgerCloseTime: "0",
  };
}