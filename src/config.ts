/**
 * Environment loading and validation.
 *
 * Fails fast and LOUDLY: a notifier that boots with a missing chat id or a
 * typo'd contract id looks healthy while silently notifying nobody, which is
 * worse than not starting. Every problem found is collected and reported in one
 * error rather than one-at-a-time across restarts.
 *
 * Split into two loaders on purpose:
 *   - {@link loadStellarConfig} needs no Telegram credentials, so the chain
 *     reader (`src/stellar/events.ts`) can be run standalone against Testnet.
 *   - {@link loadConfig} is the full bot config.
 */

import path from "node:path";

import "dotenv/config";

export interface StellarConfig {
  marketContractId: string;
  squadContractId: string;
  rpcUrl: string;
  horizonUrl: string;
  networkPassphrase: string;
}

export interface BotConfig extends StellarConfig {
  botToken: string;
  chatId: string;
  pollIntervalMs: number;
  startLookbackLedgers: number;
  cursorFile: string;
  maxNotificationsPerCycle: number;
  /**
   * Exit with {@link EXIT_RPC_PERSISTENT} (code 3) after this many consecutive
   * all-target-failed cycles. 0 disables the threshold (run forever).
   * A supervisor that restarts on exit 3 gives the process a clean slate —
   * fresh TCP connections, reset backoff — without human intervention.
   */
  consecutiveFailureExitThreshold: number;
  /**
   * When > 0, a minimal HTTP server listens on this port. GET /healthz returns
   * 200 while the poller has succeeded at least once in the last
   * `pollIntervalMs * 3` window, and 503 otherwise. 0 disables the endpoint.
   */
  httpHealthPort: number;
  /**
   * Base interval for the Stellar RPC retry back-off (ms). Each consecutive
   * all-target failure doubles the wait up to `pollIntervalMs`, then the
   * exit threshold takes over if configured.
   */
  backoffBaseMs: number;
}

export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(
      `Invalid configuration (${problems.length} problem${problems.length === 1 ? "" : "s"}):\n` +
        problems.map((p) => `  - ${p}`).join("\n") +
        `\n\nCopy .env.example to .env and fill in the missing values.`,
    );
    this.name = "ConfigError";
    this.problems = problems;
  }
}

const DEFAULTS = {
  rpcUrl: "https://soroban-testnet.stellar.org",
  horizonUrl: "https://horizon-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  pollIntervalMs: 30_000,
  minPollIntervalMs: 5_000,
  startLookbackLedgers: 60,
  cursorFile: "./data/cursor.json",
  maxNotificationsPerCycle: 20,
  consecutiveFailureExitThreshold: 20,
  httpHealthPort: 0,
  backoffBaseMs: 5_000,
} as const;

/** Strkey for a contract: `C` + 55 base32 characters. */
const CONTRACT_ID_RE = /^C[A-Z2-7]{55}$/;

function read(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

function collector() {
  const problems: string[] = [];

  return {
    problems,

    required(name: string): string {
      const value = read(name);
      if (value === undefined) {
        problems.push(`${name} is required but not set`);
        return "";
      }
      return value;
    },

    contractId(name: string): string {
      const value = this.required(name);
      if (value !== "" && !CONTRACT_ID_RE.test(value)) {
        problems.push(
          `${name} is not a Soroban contract id (expected C… strkey, 56 chars); got "${value}"`,
        );
      }
      return value;
    },

    url(name: string, fallback: string): string {
      const value = read(name) ?? fallback;
      try {
        const parsed = new URL(value);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          problems.push(`${name} must be an http(s) URL; got "${value}"`);
        }
      } catch {
        problems.push(`${name} is not a valid URL; got "${value}"`);
      }
      return value;
    },

    int(name: string, fallback: number, min: number): number {
      const raw = read(name);
      if (raw === undefined) return fallback;
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
        problems.push(`${name} must be an integer; got "${raw}"`);
        return fallback;
      }
      if (parsed < min) {
        problems.push(`${name} must be >= ${min}; got ${parsed}`);
        return fallback;
      }
      return parsed;
    },

    chatId(name: string): string {
      const value = this.required(name);
      // Telegram chat ids are integers (channels/supergroups are negative).
      // A @channelusername also works for public channels, so both are allowed.
      if (value !== "" && !/^-?\d+$/.test(value) && !/^@[A-Za-z0-9_]{4,}$/.test(value)) {
        problems.push(
          `${name} must be a numeric chat id (e.g. -1001234567890) or a @channelusername; got "${value}"`,
        );
      }
      return value;
    },
  };
}

function stellarFrom(c: ReturnType<typeof collector>): StellarConfig {
  return {
    marketContractId: c.contractId("MARKET_CONTRACT_ID"),
    squadContractId: c.contractId("SQUAD_CONTRACT_ID"),
    rpcUrl: c.url("STELLAR_RPC_URL", DEFAULTS.rpcUrl),
    horizonUrl: c.url("STELLAR_HORIZON_URL", DEFAULTS.horizonUrl),
    networkPassphrase: read("STELLAR_NETWORK_PASSPHRASE") ?? DEFAULTS.networkPassphrase,
  };
}

/** Chain-only config. No Telegram credentials required. */
export function loadStellarConfig(): StellarConfig {
  const c = collector();
  const config = stellarFrom(c);
  if (c.problems.length > 0) throw new ConfigError(c.problems);
  return config;
}

/** Full bot config: chain + Telegram + poller tuning. */
export function loadConfig(): BotConfig {
  const c = collector();
  const stellar = stellarFrom(c);

  const config: BotConfig = {
    ...stellar,
    botToken: c.required("BOT_TOKEN"),
    chatId: c.chatId("TELEGRAM_CHAT_ID"),
    pollIntervalMs: c.int("POLL_INTERVAL_MS", DEFAULTS.pollIntervalMs, DEFAULTS.minPollIntervalMs),
    startLookbackLedgers: c.int("START_LOOKBACK_LEDGERS", DEFAULTS.startLookbackLedgers, 0),
    cursorFile: path.resolve(process.cwd(), read("CURSOR_FILE") ?? DEFAULTS.cursorFile),
    maxNotificationsPerCycle: c.int(
      "MAX_NOTIFICATIONS_PER_CYCLE",
      DEFAULTS.maxNotificationsPerCycle,
      1,
    ),
    consecutiveFailureExitThreshold: c.int(
      "CONSECUTIVE_FAILURE_EXIT_THRESHOLD",
      DEFAULTS.consecutiveFailureExitThreshold,
      0,
    ),
    httpHealthPort: c.int("HTTP_HEALTH_PORT", DEFAULTS.httpHealthPort, 0),
    backoffBaseMs: c.int("BACKOFF_BASE_MS", DEFAULTS.backoffBaseMs, 100),
  };

  if (c.problems.length > 0) throw new ConfigError(c.problems);
  return config;
}

/** `testnet` / `public` / `unknown`, derived from the passphrase. Display only. */
export function networkLabel(config: StellarConfig): string {
  if (config.networkPassphrase === "Test SDF Network ; September 2015") return "testnet";
  if (config.networkPassphrase === "Public Global Stellar Network ; September 2015") return "public";
  return "custom";
}
