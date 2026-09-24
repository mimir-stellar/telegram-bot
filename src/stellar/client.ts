/**
 * Soroban RPC client construction.
 *
 * `getEvents` is the only endpoint this bot needs, and it is unauthenticated on
 * the public Testnet RPC — there is no key to configure here.
 */

import { rpc } from "@stellar/stellar-sdk";

import type { StellarConfig } from "../config.js";

export function createRpcServer(config: StellarConfig): rpc.Server {
  return new rpc.Server(config.rpcUrl, {
    // Only relevant for a local quickstart container on plain http.
    allowHttp: new URL(config.rpcUrl).protocol === "http:",
  });
}

/** Explorer link for a transaction hash, used in notification footers. */
export function txExplorerUrl(config: StellarConfig, txHash: string): string {
  const network =
    config.networkPassphrase === "Public Global Stellar Network ; September 2015"
      ? "public"
      : "testnet";
  return `https://stellar.expert/explorer/${network}/tx/${txHash}`;
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
): rpc.GetEventsResponse {
  const network =
    config.networkPassphrase === "Public Global Stellar Network ; September 2015"
      ? "public"
      : "testnet";

  return {
    events: [
      {
        type: "contract",
        contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
        id: "1234567890",
        ledger: 12345678,
        ledgerClosedAt: new Date().toISOString(),
        inSuccessfulContractEvent: true,
        contractEventType: "log",
        topic: ["bG9nIGV2ZW50"], // Base64 encoded "log event"
        data: "SGVsbG8gV29ybGQ=", // Base64 encoded "Hello World"
        txHash: txHash,
      },
    ],
    latestLedger: 12345678,
  };
}