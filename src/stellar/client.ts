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

export function createRpcServer(config: StellarConfig): rpc.Server {
  return new rpc.Server(config.rpcUrl, {
    // Only relevant for a local quickstart container on plain http.
    allowHttp: new URL(config.rpcUrl).protocol === "http:",
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