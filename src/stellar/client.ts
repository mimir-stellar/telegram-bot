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
 * CSV header for scanner output.
 * Defines the columns for machine-readable event logs.
 */
export const CSV_HEADERS = [
  "timestamp",
  "event_type",
  "contract_id",
  "event_index",
  "tx_hash",
  "payload_summary",
].join(",");

/**
 * Safely escape a value for CSV output.
 * Handles commas, quotes, and newlines to prevent CSV injection or parsing errors.
 */
export function escapeCsvField(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Format a single event record as a CSV line.
 *
 * @param timestamp - ISO 8601 timestamp of the event.
 * @param eventType - Type of the Stellar event.
 * @param contractId - Contract ID associated with the event.
 * @param eventIndex - Index of the event within the transaction.
 * @param txHash - Transaction hash.
 * @param payloadSummary - Human-readable summary of the payload (sanitized).
 */
export function formatCsvRow(
  timestamp: string,
  eventType: string,
  contractId: string,
  eventIndex: number,
  txHash: string,
  payloadSummary: string
): string {
  const fields = [
    escapeCsvField(timestamp),
    escapeCsvField(eventType),
    escapeCsvField(contractId),
    eventIndex.toString(),
    escapeCsvField(txHash),
    escapeCsvField(payloadSummary),
  ];
  return fields.join(",");
}