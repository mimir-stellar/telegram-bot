import * as fs from "fs";
import * as path from "path";

import {
  NETWORK_PASSPHRASES,
  networkLabel,
  type StellarConfig,
  type StellarNetwork,
} from "../config.js";

export type RefKind = "market" | "squad";

export interface Ref {
  kind: RefKind;
  id: string;
}

export interface StoreNetworkIdentity {
  /** Named network label (e.g. "testnet", "mainnet", "futurenet", "custom"). */
  network: string;
  /** Authoritative Stellar network passphrase. */
  networkPassphrase: string;
}

export interface StoreFile {
  version: number;
  network?: StoreNetworkIdentity | undefined;
  // chatId -> array of ref strings (e.g. "market:123")
  follows: Record<string, string[]>;
}

export const LEGACY_STORE_VERSION = 1;
export const NETWORK_BOUND_STORE_VERSION = 2;
export const STORE_VERSION = NETWORK_BOUND_STORE_VERSION;

export const DEFAULT_MAX_PER_CHAT = 50;

export const DEFAULT_MAX_TOTAL = 5000;

export class FollowStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FollowStoreError";
  }
}

export class FollowStoreNetworkMismatchError extends FollowStoreError {
  readonly storedNetwork: StoreNetworkIdentity;
  readonly expectedNetwork: StoreNetworkIdentity;

  constructor(storedNetwork: StoreNetworkIdentity, expectedNetwork: StoreNetworkIdentity) {
    super(
      `follow-store network mismatch: file is bound to "${storedNetwork.network}" ` +
        `("${storedNetwork.networkPassphrase}") but bot is configured for ` +
        `"${expectedNetwork.network}" ("${expectedNetwork.networkPassphrase}"). ` +
        `Use a separate follow-store file per network or run migrateFollowStoreNetwork explicitly.`,
    );
    this.name = "FollowStoreNetworkMismatchError";
    this.storedNetwork = storedNetwork;
    this.expectedNetwork = expectedNetwork;
  }
}

export class FollowStoreMigrationRequiredError extends FollowStoreError {
  readonly fromVersion: number;
  readonly targetNetwork: StoreNetworkIdentity;

  constructor(fromVersion: number, targetNetwork: StoreNetworkIdentity) {
    super(
      `follow-store file uses unbound schema v${fromVersion} and cannot be implicitly reused on ` +
        `"${targetNetwork.network}" ("${targetNetwork.networkPassphrase}"). ` +
        `Run migrateFollowStoreNetwork explicitly to bind existing subscriptions.`,
    );
    this.name = "FollowStoreMigrationRequiredError";
    this.fromVersion = fromVersion;
    this.targetNetwork = targetNetwork;
  }
}

export interface FollowStoreOptions {
  filePath: string;
  maxPerChat?: number;
  maxTotal?: number;
  // Aliases for API compatibility.
  maxFollowsPerChat?: number;
  maxTotalEntries?: number;
  /** Optional Stellar network binding. When supplied, enforces v2 network-bound schema. */
  network?: string | StoreNetworkIdentity | undefined;
  networkPassphrase?: string | undefined;
}

export interface MigrateFollowStoreOptions {
  /**
   * Required when re-binding an already-bound v2 file from one Stellar network
   * to another: must match the stored `network` or `networkPassphrase`, or
   * `forceCrossNetwork` must be `true`.
   */
  expectedSourceNetwork?: string | undefined;
  forceCrossNetwork?: boolean | undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolves a canonical {@link StoreNetworkIdentity} from a Stellar config,
 * passphrase, or named network.
 */
export function resolveStoreNetworkIdentity(
  input:
    | StoreNetworkIdentity
    | Pick<StellarConfig, "networkPassphrase" | "network">
    | { network?: string | undefined; networkPassphrase?: string | undefined },
): StoreNetworkIdentity {
  const rawNetwork = typeof input.network === "string" ? input.network.trim() : "";
  const rawPassphrase =
    typeof input.networkPassphrase === "string" ? input.networkPassphrase.trim() : "";

  if (rawPassphrase !== "") {
    let inferredLabel = rawNetwork;
    if (!inferredLabel) {
      inferredLabel = networkLabel({
        networkPassphrase: rawPassphrase,
        marketContractId: "",
        squadContractId: "",
        marketContractVersion: "v1",
        squadContractVersion: "v1",
        rpcUrl: "",
        horizonUrl: "",
        explorerBaseUrl: "",
      });
    }
    return {
      network: inferredLabel,
      networkPassphrase: rawPassphrase,
    };
  }

  if (
    rawNetwork === "testnet" ||
    rawNetwork === "mainnet" ||
    rawNetwork === "futurenet"
  ) {
    return {
      network: rawNetwork,
      networkPassphrase: NETWORK_PASSPHRASES[rawNetwork as Exclude<StellarNetwork, "custom">],
    };
  }

  throw new FollowStoreError(
    "networkPassphrase is required when binding FollowStore to a custom Stellar network",
  );
}

function normalizeOptionsNetwork(options: FollowStoreOptions): StoreNetworkIdentity | null {
  if (options.network === undefined && options.networkPassphrase === undefined) {
    return null;
  }
  if (isPlainObject(options.network)) {
    return resolveStoreNetworkIdentity({
      network: typeof options.network.network === "string" ? options.network.network : undefined,
      networkPassphrase:
        typeof options.network.networkPassphrase === "string"
          ? options.network.networkPassphrase
          : options.networkPassphrase,
    });
  }
  return resolveStoreNetworkIdentity({
    network: typeof options.network === "string" ? options.network : undefined,
    networkPassphrase: options.networkPassphrase,
  });
}

export function sameStoreNetwork(
  a: StoreNetworkIdentity,
  b: StoreNetworkIdentity,
): boolean {
  return a.networkPassphrase === b.networkPassphrase;
}

export function parseRef(ref: string): Ref | null {
  if (typeof ref !== "string") return null;
  const idx = ref.indexOf(":");
  if (idx <= 0) return null;
  const kind = ref.slice(0, idx);
  const id = ref.slice(idx + 1);
  if (kind !== "market" && kind !== "squad") return null;
  if (!id) return null;
  // Reject whitespace, control characters and a second ':' in id, so a ref
  // always splits into exactly one kind and one id.
  if (/[\s\u0000-\u001F:]/.test(id)) return null;
  return { kind, id };
}

export function formatRef(kind: RefKind, id: string): string {
  return `${kind}:${id}`;
}

function emptyStore(network: StoreNetworkIdentity | null): StoreFile {
  if (network !== null) {
    return {
      version: NETWORK_BOUND_STORE_VERSION,
      network: { ...network },
      follows: {},
    };
  }
  return { version: LEGACY_STORE_VERSION, follows: {} };
}

function validateFollowsRecord(rawFollows: unknown): Record<string, string[]> {
  if (!isPlainObject(rawFollows)) {
    throw new FollowStoreError("follows is not an object");
  }
  const follows: Record<string, string[]> = {};
  for (const [chatId, list] of Object.entries(rawFollows)) {
    if (!Array.isArray(list)) {
      throw new FollowStoreError(`follows[${chatId}] is not an array`);
    }
    const cleaned: string[] = [];
    for (const entry of list) {
      if (typeof entry !== "string" || parseRef(entry) === null) {
        throw new FollowStoreError(`invalid ref in follows[${chatId}]`);
      }
      cleaned.push(entry);
    }
    follows[chatId] = cleaned;
  }
  return follows;
}

function parseStoredNetwork(rawNetwork: unknown): StoreNetworkIdentity {
  if (!isPlainObject(rawNetwork)) {
    throw new FollowStoreError("store network metadata is missing or invalid");
  }
  const network =
    typeof rawNetwork.network === "string" ? rawNetwork.network.trim() : "";
  const networkPassphrase =
    typeof rawNetwork.networkPassphrase === "string"
      ? rawNetwork.networkPassphrase.trim()
      : "";
  if (!network || !networkPassphrase) {
    throw new FollowStoreError("store network metadata requires network and networkPassphrase");
  }
  return { network, networkPassphrase };
}

function validateStoreFile(
  data: unknown,
  expectedNetwork: StoreNetworkIdentity | null,
): StoreFile {
  if (!isPlainObject(data)) {
    throw new FollowStoreError("store file is not an object");
  }

  if (data.version === LEGACY_STORE_VERSION) {
    const follows = validateFollowsRecord(data.follows);
    if (expectedNetwork !== null) {
      throw new FollowStoreMigrationRequiredError(
        LEGACY_STORE_VERSION,
        expectedNetwork,
      );
    }
    return { version: LEGACY_STORE_VERSION, follows };
  }

  if (data.version === NETWORK_BOUND_STORE_VERSION) {
    const storedNetwork = parseStoredNetwork(data.network);
    const follows = validateFollowsRecord(data.follows);
    if (expectedNetwork !== null && !sameStoreNetwork(storedNetwork, expectedNetwork)) {
      throw new FollowStoreNetworkMismatchError(storedNetwork, expectedNetwork);
    }
    return {
      version: NETWORK_BOUND_STORE_VERSION,
      network: storedNetwork,
      follows,
    };
  }

  throw new FollowStoreError(`unsupported store version: ${String(data.version)}`);
}

function quarantineFile(filePath: string): void {
  const timestamp = Date.now();
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const target = path.join(dir, `${base}.corrupt.${timestamp}`);
  try {
    fs.renameSync(filePath, target);
  } catch {
    // If quarantine fails (e.g. permission), remove the corrupt file so we can start fresh.
    try {
      fs.unlinkSync(filePath);
    } catch {
      // ignore - best effort
    }
  }
}

function writeStoreAtomically(filePath: string, data: StoreFile): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const payload = JSON.stringify(data, null, 2) + "\n";
  fs.writeFileSync(tmp, payload, "utf8");
  fs.renameSync(tmp, filePath);
}

/**
 * Explicitly migrates an existing follow-store file (either legacy unbound v1
 * or an existing network-bound v2 file with explicit source confirmation) to
 * the target Stellar network identity.
 */
export function migrateFollowStoreNetwork(
  filePath: string,
  target:
    | StoreNetworkIdentity
    | Pick<StellarConfig, "networkPassphrase" | "network">
    | { network?: string | undefined; networkPassphrase?: string | undefined },
  options: MigrateFollowStoreOptions = {},
): {
  migrated: boolean;
  previousVersion: number | null;
  previousNetwork: StoreNetworkIdentity | null;
  network: StoreNetworkIdentity;
  totalFollows: number;
} {
  const targetIdentity = resolveStoreNetworkIdentity(target);

  if (!fs.existsSync(filePath)) {
    const fresh = emptyStore(targetIdentity);
    writeStoreAtomically(filePath, fresh);
    return {
      migrated: true,
      previousVersion: null,
      previousNetwork: null,
      network: targetIdentity,
      totalFollows: 0,
    };
  }

  const raw = fs.readFileSync(filePath, "utf8");
  if (raw.trim() === "") {
    const fresh = emptyStore(targetIdentity);
    writeStoreAtomically(filePath, fresh);
    return {
      migrated: true,
      previousVersion: null,
      previousNetwork: null,
      network: targetIdentity,
      totalFollows: 0,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new FollowStoreError("cannot migrate corrupt follow-store JSON");
  }
  if (!isPlainObject(parsed)) {
    throw new FollowStoreError("store file is not an object");
  }

  if (parsed.version === LEGACY_STORE_VERSION) {
    const follows = validateFollowsRecord(parsed.follows);
    const next: StoreFile = {
      version: NETWORK_BOUND_STORE_VERSION,
      network: targetIdentity,
      follows,
    };
    writeStoreAtomically(filePath, next);
    const totalFollows = Object.values(follows).reduce((acc, l) => acc + l.length, 0);
    return {
      migrated: true,
      previousVersion: LEGACY_STORE_VERSION,
      previousNetwork: null,
      network: targetIdentity,
      totalFollows,
    };
  }

  if (parsed.version === NETWORK_BOUND_STORE_VERSION) {
    const storedNetwork = parseStoredNetwork(parsed.network);
    const follows = validateFollowsRecord(parsed.follows);
    const totalFollows = Object.values(follows).reduce((acc, l) => acc + l.length, 0);

    if (sameStoreNetwork(storedNetwork, targetIdentity)) {
      return {
        migrated: false,
        previousVersion: NETWORK_BOUND_STORE_VERSION,
        previousNetwork: storedNetwork,
        network: targetIdentity,
        totalFollows,
      };
    }

    const expectedSource = options.expectedSourceNetwork?.trim();
    const sourceConfirmed =
      options.forceCrossNetwork === true ||
      (expectedSource !== undefined &&
        expectedSource !== "" &&
        (expectedSource === storedNetwork.network ||
          expectedSource === storedNetwork.networkPassphrase));

    if (!sourceConfirmed) {
      throw new FollowStoreNetworkMismatchError(storedNetwork, targetIdentity);
    }

    const next: StoreFile = {
      version: NETWORK_BOUND_STORE_VERSION,
      network: targetIdentity,
      follows,
    };
    writeStoreAtomically(filePath, next);
    return {
      migrated: true,
      previousVersion: NETWORK_BOUND_STORE_VERSION,
      previousNetwork: storedNetwork,
      network: targetIdentity,
      totalFollows,
    };
  }

  throw new FollowStoreError(`unsupported store version: ${String(parsed.version)}`);
}

export class FollowStore {
  private readonly filePath: string;
  private readonly maxPerChat: number;
  private readonly maxTotal: number;
  private readonly boundNetwork: StoreNetworkIdentity | null;

  constructor(options: FollowStoreOptions) {
    this.filePath = options.filePath;
    this.maxPerChat =
      options.maxPerChat ?? options.maxFollowsPerChat ?? DEFAULT_MAX_PER_CHAT;
    this.maxTotal = options.maxTotal ?? options.maxTotalEntries ?? DEFAULT_MAX_TOTAL;
    this.boundNetwork = normalizeOptionsNetwork(options);
  }

  /** Configured Stellar network identity for this store, or null when unbound. */
  networkIdentity(): StoreNetworkIdentity | null {
    return this.boundNetwork ? { ...this.boundNetwork } : null;
  }

  /**
   * Verifies that the underlying file (if present) is compatible with `network`
   * and that this instance's configured network matches `network`.
   */
  verifyNetworkBinding(
    expected:
      | StoreNetworkIdentity
      | Pick<StellarConfig, "networkPassphrase" | "network">,
  ): StoreNetworkIdentity {
    const resolved = resolveStoreNetworkIdentity(expected);
    if (this.boundNetwork !== null && !sameStoreNetwork(this.boundNetwork, resolved)) {
      throw new FollowStoreNetworkMismatchError(this.boundNetwork, resolved);
    }
    if (fs.existsSync(this.filePath)) {
      const raw = fs.readFileSync(this.filePath, "utf8");
      if (raw.trim() !== "") {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          // Corrupt files are handled by read()'s quarantine path.
          return resolved;
        }
        validateStoreFile(parsed, resolved);
      }
    }
    return resolved;
  }

  private read(): StoreFile {
    if (!fs.existsSync(this.filePath)) {
      return emptyStore(this.boundNetwork);
    }
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf8");
    } catch {
      quarantineFile(this.filePath);
      return emptyStore(this.boundNetwork);
    }
    if (raw.trim() === "") {
      return emptyStore(this.boundNetwork);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      quarantineFile(this.filePath);
      return emptyStore(this.boundNetwork);
    }
    try {
      return validateStoreFile(parsed, this.boundNetwork);
    } catch (err) {
      // Never quarantine or overwrite a valid store belonging to another
      // network or awaiting explicit v1->v2 migration.
      if (
        err instanceof FollowStoreNetworkMismatchError ||
        err instanceof FollowStoreMigrationRequiredError
      ) {
        throw err;
      }
      quarantineFile(this.filePath);
      return emptyStore(this.boundNetwork);
    }
  }

  private write(data: StoreFile): void {
    const toWrite: StoreFile =
      this.boundNetwork !== null
        ? {
            version: NETWORK_BOUND_STORE_VERSION,
            network: { ...this.boundNetwork },
            follows: data.follows,
          }
        : data;
    writeStoreAtomically(this.filePath, toWrite);
  }

  private totalCount(data: StoreFile): number {
    let total = 0;
    for (const list of Object.values(data.follows)) total += list.length;
    return total;
  }

  follow(chatId: string, ref: string): boolean {
    if (typeof chatId !== "string" || chatId.length === 0) {
      throw new FollowStoreError("chatId must be a non-empty string");
    }
    if (parseRef(ref) === null) {
      throw new FollowStoreError(`invalid ref: ${ref}`);
    }
    const data = this.read();
    const existing = data.follows[chatId] ?? [];
    if (existing.includes(ref)) {
      return false;
    }
    if (existing.length >= this.maxPerChat) {
      throw new FollowStoreError(`per-chat follow limit reached (${this.maxPerChat})`);
    }
    if (this.totalCount(data) >= this.maxTotal) {
      throw new FollowStoreError(`total follow limit reached (${this.maxTotal})`);
    }
    data.follows[chatId] = [...existing, ref];
    this.write(data);
    return true;
  }

  unfollow(chatId: string, ref: string): boolean {
    if (typeof chatId !== "string" || chatId.length === 0) {
      throw new FollowStoreError("chatId must be a non-empty string");
    }
    if (parseRef(ref) === null) {
      throw new FollowStoreError(`invalid ref: ${ref}`);
    }
    const data = this.read();
    const existing = data.follows[chatId];
    if (!existing || !existing.includes(ref)) {
      return false;
    }
    const next = existing.filter((entry) => entry !== ref);
    if (next.length === 0) {
      delete data.follows[chatId];
    } else {
      data.follows[chatId] = next;
    }
    this.write(data);
    return true;
  }

  list(chatId: string): string[] {
    if (typeof chatId !== "string" || chatId.length === 0) {
      throw new FollowStoreError("chatId must be a non-empty string");
    }
    const data = this.read();
    return [...(data.follows[chatId] ?? [])];
  }

  followersOf(ref: string): string[] {
    if (parseRef(ref) === null) {
      throw new FollowStoreError(`invalid ref: ${ref}`);
    }
    const data = this.read();
    const result: string[] = [];
    for (const [chatId, list] of Object.entries(data.follows)) {
      if (list.includes(ref)) result.push(chatId);
    }
    return result;
  }
}

export function createFollowStore(options: FollowStoreOptions): FollowStore {
  return new FollowStore(options);
}

/**
 * Creates a {@link FollowStore} bound to the configured Stellar network on `config`.
 */
export function createNetworkBoundFollowStore(
  filePath: string,
  config: Pick<StellarConfig, "networkPassphrase" | "network">,
  options: Omit<FollowStoreOptions, "filePath" | "network" | "networkPassphrase"> = {},
): FollowStore {
  const identity = resolveStoreNetworkIdentity(config);
  return new FollowStore({
    ...options,
    filePath,
    network: identity,
  });
}
