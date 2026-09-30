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
import { networkLabel } from "../config.js";

export function createRpcServer(config: StellarConfig): rpc.Server {
  return new rpc.Server(config.rpcUrl, {
    // Only relevant for a local quickstart container on plain http.
    allowHttp: new URL(config.rpcUrl).protocol === "http:",
    timeout: 15000,
  });
}

/** Default stellar.expert origin; override with STELLAR_EXPLORER_BASE_URL. */
export const DEFAULT_EXPLORER_BASE_URL = "https://stellar.expert/explorer";

/**
 * Resolve the explorer network path segment from the configured passphrase.
 * Custom / unknown networks fall back to `testnet` so links stay usable in
 * local quickstart deployments.
 */
export function explorerNetworkSegment(config: StellarConfig): "public" | "testnet" {
  const label = networkLabel(config);
  return label === "public" ? "public" : "testnet";
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
  const hash = txHash.trim();
  if (!hash) return "";
  const network = explorerNetworkSegment(config);
  return `${explorerBase(config)}/${network}/tx/${explorerPart(hash)}`;
}

/** Explorer link for a classic / contract account. */
export function accountExplorerUrl(config: StellarConfig, address: string): string {
  const id = address.trim();
  if (!id) return "";
  const network = explorerNetworkSegment(config);
  return `${explorerBase(config)}/${network}/account/${explorerPart(id)}`;
}

/** Explorer link for a Soroban contract id, used by /contracts. */
export function contractExplorerUrl(config: StellarConfig, contractId: string): string {
  const id = contractId.trim();
  if (!id) return "";
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

// ── Network passphrase verification ──────────────────────────────────────────
//
// Verify that the RPC's reported network passphrase matches the configured
// value. A mismatch indicates a serious misconfiguration: either the RPC is
// pointed at the wrong network (Testnet vs Public), or the STELLAR_NETWORK_PASSPHRASE
// env var is wrong. This check runs once at boot as part of the startup health
// sequence, so the bot fails fast before it can silently emit notifications on
// the wrong network.

/**
 * Validate that the RPC reports a network passphrase matching the
 * configured value.
 *
 * Throws a bounded {@link NetworkPassphraseMismatchError} when the RPC's
 * passphrase does not match the configured value, is missing, or is not a string.
 * The error message never includes the actual passphrases, so it is safe to
 * surface in logs and status output without leaking secrets.
 *
 * @param server The Soroban RPC server (from {@link createRpcServer})
 * @param config The bot configuration (contains STELLAR_NETWORK_PASSPHRASE)
 * @throws {NetworkPassphraseMismatchError} When passphrase validation fails
 */
export async function validateNetworkPassphrase(
  server: rpc.Server,
  config: StellarConfig,
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

  const rpcPassphrase = (network as Record<string, unknown>)?.passphrase;
  if (typeof rpcPassphrase !== "string") {
    throw new NetworkPassphraseMismatchError(
      "malformed",
      `RPC getNetwork returned a malformed passphrase (expected a string; got ${typeof rpcPassphrase})`,
    );
  }

  if (rpcPassphrase !== config.networkPassphrase) {
    throw new NetworkPassphraseMismatchError(
      "mismatch",
      `RPC network passphrase does not match the configured value (configured=${config.networkPassphrase.length} chars, received=${rpcPassphrase.length} chars)`,
    );
  }
}

/** Render an untrusted remote error without echoing an unbounded payload. */
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
