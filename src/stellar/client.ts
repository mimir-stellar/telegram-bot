/**
 * Soroban RPC client construction and Stellar explorer URL helpers.
 *
 * `getEvents` is the only endpoint this bot needs, and it is unauthenticated on
 * the public Testnet RPC — there is no key to configure here.
 *
 * Explorer links are centralized here so notifications, logs, and CLI helpers
 * share one construction path (network segment + optional base override).
 */

import { rpc } from "@stellar/stellar-sdk";

import type { StellarConfig } from "../config.js";
import { networkLabel } from "../config.js";

export class RpcPassphraseError extends Error {
  constructor(expected: string, actual: string) {
    super(
      `RPC network passphrase mismatch: expected "${expected}" but RPC reported "${actual}". ` +
      `Check STELLAR_RPC_URL and STELLAR_NETWORK_PASSPHRASE configuration.`,
    );
    this.name = "RpcPassphraseError";
  }
}

/**
 * Create an RPC server and verify its network passphrase matches the configured value.
 * This fail-fast check at boot prevents silent misconfigurations where the bot reads
 * events from the wrong network.
 *
 * Throws RpcPassphraseError if the passphrase does not match.
 */
export async function createRpcServer(config: StellarConfig): Promise<rpc.Server> {
  const server = new rpc.Server(config.rpcUrl, {
    // Only relevant for a local quickstart container on plain http.
    allowHttp: new URL(config.rpcUrl).protocol === "http:",
  });

  // Verify the RPC's passphrase matches the configured one. This is a fail-fast
  // check that prevents configuration errors from silently producing wrong results.
  const network = await server.getNetwork();
  if (network.passphrase !== config.networkPassphrase) {
    throw new RpcPassphraseError(config.networkPassphrase, network.passphrase);
  }

  return server;
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

/** Explorer link for a transaction hash, used in notification footers. */
export function txExplorerUrl(config: StellarConfig, txHash: string): string {
  const hash = txHash.trim();
  if (!hash) return "";
  const network = explorerNetworkSegment(config);
  return `${explorerBase(config)}/${network}/tx/${hash}`;
}

/** Explorer link for a classic / contract account. */
export function accountExplorerUrl(config: StellarConfig, address: string): string {
  const id = address.trim();
  if (!id) return "";
  const network = explorerNetworkSegment(config);
  return `${explorerBase(config)}/${network}/account/${id}`;
}

/** Explorer link for a Soroban contract id. */
export function contractExplorerUrl(config: StellarConfig, contractId: string): string {
  const id = contractId.trim();
  if (!id) return "";
  const network = explorerNetworkSegment(config);
  return `${explorerBase(config)}/${network}/contract/${id}`;
}
