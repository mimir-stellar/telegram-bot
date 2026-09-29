/*
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
 *
 * ── Profiles ────────────────────────────────────────────────────────────────────
 *
 * `MIMIR_PROFILE=mock` selects the local Soroban mock profile: it supplies
 * defaults for values the environment does NOT set (loopback RPC, fixture
 * contract ids, an isolated cursor file, placeholder credentials). Explicit
 * environment variables always win, so a profile can never change an existing
 * deployment's configuration. Any other profile name fails fast.
 *
 * ── Provenance ─────────────────────────────────────────────────────────────────
 *
 * {@link configProvenance} reports which source supplied each setting — the
 * environment, the `.env` file, the active profile, a built-in default, or
 * another setting. It reports names and origins only: a value, secret or not,
 * never enters the result, so it is safe in boot logs and in `/health`. The
 * `.env` file is loaded here rather than by `dotenv/config` for exactly that
 * reason: the loader has to see the environment *before* the merge to tell a
 * value the machine provided from one the file provided.
 */

import path from "node:path";

import { config as loadDotenv, type DotenvConfigOptions } from "dotenv";

import {
  MOCK_BOT_TOKEN,
  MOCK_CHAT_ID,
  MOCK_CURSOR_FILE,
  MOCK_MARKET_CONTRACT_ID,
  MOCK_NETWORK_PASSPHRASE,
  MOCK_PROFILE_NAME,
  MOCK_RPC_DEFAULT_PORT,
  MOCK_SQUAD_CONTRACT_ID,
} from "./stellar/mock-constants.js";

import {
  parseNotificationFeatureFlags,
  type NotificationFeatureFlags,
} from "./notifications/featureFlags.js";
/**
 * The environment as it was before the `.env` file was merged in.
 *
 * dotenv never overwrites a variable that is already set (unless
 * `DOTENV_CONFIG_OVERRIDE` asks it to), so this snapshot is what separates a
 * value the machine supplied from one the file supplied, without ever comparing
 * the values themselves.
 */
const ENV_BEFORE_FILE = new Set(Object.keys(process.env));

/** What the `.env` file declared, captured once at import. Names only. */
const ENV_FILE = loadEnvFile();

interface EnvFileState {
  /** True when a `.env` file was found and parsed. */
  present: boolean;
  /** Every name the file declares, including the ones it leaves empty. */
  declared: ReadonlySet<string>;
  /** Names whose effective value the file supplied (it can lose a tie). */
  supplied: ReadonlySet<string>;
}

function dotenvConfigOptions(): DotenvConfigOptions {
  // `dotenv/config` is no longer the loader: this module loads the file so it
  // can record where each value came from. Honour the same DOTENV_CONFIG_*
  // variables the CLI loader honours, so existing deployments are unaffected.
  const options: DotenvConfigOptions = {};
  const file = process.env.DOTENV_CONFIG_PATH;
  if (file !== undefined && file.trim() !== "") {
    options.path = path.resolve(process.cwd(), file.trim());
  }
  const encoding = process.env.DOTENV_CONFIG_ENCODING;
  if (encoding !== undefined && encoding.trim() !== "") options.encoding = encoding;
  options.override = process.env.DOTENV_CONFIG_OVERRIDE === "true";
  options.debug = process.env.DOTENV_CONFIG_DEBUG === "true";
  return options;
}

/**
 * Loads `.env` and records which names it supplied. Only the parsed output's
 * *keys* are kept — the values themselves are dropped on the floor here, which
 * is what makes every provenance report below safe to publish.
 */
function loadEnvFile(): EnvFileState {
  try {
    const options = dotenvConfigOptions();
    const result = loadDotenv(options);
    const declared = new Set(Object.keys(result.parsed ?? {}));
    const supplied = new Set(
      [...declared].filter((key) => options.override === true || !ENV_BEFORE_FILE.has(key)),
    );
    // dotenv always returns `parsed` (an empty object when the file is missing)
    // and reports a missing file through `error`, so that is the presence test.
    return { present: result.error === undefined, declared, supplied };
  } catch {
    // An unreadable file is not an error: `read()` already falls back to the
    // real environment, the active profile, then the built-in defaults.
    return { present: false, declared: new Set(), supplied: new Set() };
  }
}

export interface StellarConfig {
  marketContractId: string;
  squadContractId: string;
  rpcUrl: string;
  horizonUrl: string;
  networkPassphrase: string;
  /** Optional override for stellar.expert (or compatible) explorer origin. */
  explorerBaseUrl: string;
}

export interface BotConfig extends StellarConfig {
  botToken: string;
  chatId: string;
  /** Optional per-contract destinations; absent values use `chatId`. */
  marketChatId?: string;
  squadChatId?: string;
  /** Chats allowed to use /status. Empty array means no restriction. */
  allowedChatIds: string[];
  /** Telegram user id allowed to run operator-only commands. Null disables them. */
  operatorTelegramUserId: string | null;
  pollIntervalMs: number;
  startLookbackLedgers: number;
  cursorFile: string;
  /** Exclusive lock so only one process owns the cursor. */
  lockFile: string;
  statusFile: string;
  maxNotificationsPerCycle: number;
  /** Coarse notification feature flags (see NOTIFY_* env vars). */
  featureFlags: NotificationFeatureFlags;
  /** Append-only JSONL audit trail (see src/audit.ts). Empty disables it. */
  auditFile: string;
  /**
   * Number of recent event ids retained per contract to suppress redelivery
   * across overlapping pages, resumed cursors, and restarts. `0` disables it.
   */
  dedupWindow: number;
  /** Loopback host for the local HTTP health endpoint. */
  healthHost: string;
  /** TCP port for the health endpoint. `0` disables the listener. */
  healthPort: number;
  /**
   * After the first successful poll, treat the process as degraded if no
   * successful cycle lands within this window. `0` disables the stale check.
   */
  healthStaleMs: number;
  /**
   * Wall-clock budget for retrying the startup RPC `getHealth()` probe.
   * `0` means a single attempt with no retries.
   */
  startupHealthDeadlineMs: number;
  /**
   * Delay between failed startup RPC health attempts (capped by remaining
   * deadline). Ignored when `startupHealthDeadlineMs` is `0`.
   */
  startupHealthRetryMs: number;
  /**
   * How long a graceful shutdown waits for an in-flight cycle before flushing
   * cursor state and giving up on it. `0` skips the wait entirely.
   */
  shutdownTimeoutMs: number;
  /**
   * Wall-clock budget for a single Telegram `sendMessage` call. `0` disables
   * the timeout (not recommended). Bounds a wedged Telegram connection so a
   * cycle cannot stall the poller indefinitely.
   */
  telegramSendTimeoutMs: number;
  /** When true, notifications sent to Telegram are formatted in preview mode. */
  channelPreviewMode: boolean;
}

/** Fallback drain budget when a config object predates `SHUTDOWN_TIMEOUT_MS`. */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[], hint?: string) {
    super(
      `Invalid configuration (${problems.length} problem${problems.length === 1 ? "" : "s”):\n` +
        problems.map((p) => `  - ${p}`).join("\n") +
        `\n\n${hint ?? "Copy .env.example to .env and fill in the missing values."}`,
    );
    this.name = "ConfigError";
    this.problems = problems;
  }
}

const DEFAULTS = {
  rpcUrl: "https://soroban-testnet.stellar.org",
  horizonUrl: "https://horizon-testnet.stellar.org",
  networkPassphrase: "Test DF Network ; September 2015",
  pollIntervalMs: 30_000,
  minPollIntervalMs: 5_000,
  startLookbackLedgers: 60,
  cursorFile: "./data/cursor.json",
  lockFile: "./data/poller.lock",
  statusFile: "./data/status.json",
  maxNotificationsPerCycle: 20,
  auditFile: "./data/audit.jsonl",
  dedupWindow: 256,
  healthHost: "127.0.0.1",
  healthPort: 8787,
  // 3× default poll interval — one missed cycle is fine; three is not.
  healthStaleMs: 90_000,
  // Retry RPC getHealth at boot for up to 30s (Testnet blips / deploy races).
  startupHealthDeadlineMs: 30_000,
  startupHealthRetryMs: 1_000,
  // Long enough for an in-flight read to finish and its cursors to land, short
  // enough that a deploy is never held open by a wedged RPC.
  shutdownTimeoutMs: DEFAULT_SHUTDOWN_TIMEOUT_MS,
  // Telegram's own API timeout is ~10s; 15s leaves headroom for slow networks
  // without letting a hung socket stall a whole poll cycle.
  // Override with TELEGRAM_SEND_TIMEOUT_MS; `0` disables the timeout entirely
  // (not recommended) and is intended only for local debugging.
  telegramSendTimeoutMs: 15_000,
  channelPreviewMode: false,
} as const;

/**
 * Platform deployers (Railway among them) inject a `PORT` variable and probe it
 * for the deploy healthcheck. When `HEALTH_PORT` is unset we fall back to it,
 * so the `/health` listener is reachable without a manual override. `PORT` is
 * not a default local dev value, so the loopback port still wins on a desktop.
 */
function defaultHealthPort(): number {
  const port = Number(process.env.PORT);
  if (Number.isInteger(port) && port > 0) return port;
  return DEFAULTS.healthPort;
}

/** Strkey for a contract: `C` + 55 base32 characters. */
const CONTRACT_ID_RE = /^C[A-Z2-7]{55}$/;

/**
 * Defaults each profile supplies for values the environment leaves unset.
 * Profile values never override explicit environment variables.
 */
const PROFILE_DEFAULTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  [MOCK_PROFILE_NAME]: {
    MARKET_CONTRACT_ID: MOCK_MARKET_CONTRACT_ID,
    SQUAD_CONTRACT_ID: MOCK_SQUAD_CONTRACT_ID,
    STELLAR_RPC_URL: `http://127.0.0.1:${MOCK_RPC_DEFAULT_PORT}`,
    STELLAR_HORIZON_URL: `http://127.0.0.1:${MOCK_RPC_DEFAULT_PORT}/horizon`,
    STELLAR_NETWORK_PASSPHRASE: MOCK_NETWORK_PASSTHRASE,
    CURSOR_FILE: MOCK_CURSOR_FILE,
    BOT_TOKEN: MOCK_BOT_TOKEN,
    TELEGRAM_CHAT_ID: MOCK_CHAT_ID,
  },
};

/** The profile selected by `MIMIR_PROFILE`, or null when unset. Display/boot use. */
export function activeProfileName(): string | null {
  return read("MIMIR_PROFILE") ?? null;
}

/** Profile defaults for the active profile. Unknown names fail fast. */
function resolveProfileDefaults(): Record<string, string> {
  const name = read("MIMIR_PROFILE");
  if (name === undefined) return {};
  const defaults = PROFILE_DEFAULTS[name];
  if (!defaults) {
    throw new ConfigError(
      [`MIMIR_PROFILE must be "${MOCK_PROFILE_NAME}" when set; got "${name}"`],
      `Unset MIMIR_PROFILE, or set MIMIR_PROFILE=${MOCK_PROFILE_NAME} for the local mock.`,
    );
  }
  return { ...defaults };
}

function read(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

function collector(profile: Record<string, string>) {
  const problems: string[] = [];
  /** Environment first, then the active profile's defaults. */
  const get = (name: string): string | undefined => read(name) ?? profile[name];

  return {
    problems,

    get,

    required(name: string): string {
      const value = get(name);
      if (value === undefined) {
        problems.push(`${name} is required but not set`);
        return "";
      }
      return value;
    },

    contractId(name: string): string {
      const value = this.required(name);
      if (value !== "" && !CONTRACT_ID_RE.test(value)) {
        problems.push(`${name} must be a 56-character Strkey contract id (C…), got "${value}"`);
      }
      return value;
    },

    integer(name: string, fallback: number, { min = 0 }: { min?: number } = {}): number {
      const raw = get(name);
      if (raw === undefined) return fallback;
      const value = Number(raw);
      if (!Number.isInteger(value) || value < min) {
        problems.push(`${name} must be an integer >= ${min}, got "${raw}"`);
        return fallback;
      }
      return value;
    },

    boolean(name: string, fallback: boolean): boolean {
      const raw = get(name);
      if (raw === undefined) return fallback;
      const normalized = raw.toLowerCase();
      if (normalized === "true" || normalized === "1") return true;
      if (normalized === "false" || normalized === "0") return false;
      problems.push(`${name} must be true/false or 1/0, got "${raw}"`);
      return fallback;
    },

    list(name: string): string[] {
      const raw = get(name);
      if (raw === undefined) return [];
      return raw
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== "");
    },

    optional(name: string): string | undefined {
      return get(name);
    },
  };
}

/** The collector type, exported for tests that drive the loaders directly. */
export type ConfigCollector = ReturnType<typeof collector>;

/**
 * Loads the chain-reading config. No Telegram credentials are required,
 * so `src/stellar/events.ts` can be run standalone.
 */
export function loadStellarConfig(): StellarConfig {
  const profile = resolveProfileDefaults();
  const c = collector(profile);

  const config: StellarConfig = {
    marketContractId: c.contractId("MARKET_CONTRACT_ID"),
    squadContractId: c.contractId("SQUAD_CONTRACT_ID"),
    rpcUrl: c.optional("STELLAR_RPC_URL") ?? DEFAULTS.rpcUrl,
    horizonUrl: c.optional("STELLAR_HORIZON_URL") ?? DEFAULTS.horizonUrl,
    networkPassphrase: c.optional("STELLAR_NETWORK_PASSTHRASE") ?? DEFAULTS.networkPassphrase,
    explorerBaseUrl: c.optional("EXPLORER_BASE_URL") ?? "",
  };

  if (c.problems.length > 0) {
    throw new ConfigError(c.problems);
  }
  return config;
}

/**
 * Loads the full bot config, including Telegram credentials and the
 * notification/lifecycle settings.
 */
export function loadConfig(): BotConfig {
  const profile = resolveProfileDefaults();
  const c = collector(profile);

  const stellar = loadStellarConfig();

  const config: BotConfig = {
    ...stellar,
    botToken: c.required("BOT_TOKEN"),
    chatId: c.required("TELEGRAM_CHAT_ID"),
    marketChatId: c.optional("MARKET_CHAT_ID"),
    squadChatId: c.optional("SQUAD_CHAT_ID"),
    allowedChatIds: c.list("ALLOWED_CHAT_IDS"),
    operatorTelegramUserId: c.optional("OPERATOR_TELEGRAM_USER_ID") ?? null,
    pollIntervalMs: c.integer("POLL_INTERVAL_MS", DEFAULTS.pollIntervalMs, {
      min: DEFAULTS.minPollIntervalMs,
    }),
    startLookbackLedgers: c.integer("START_LOOKBACK_LEDGERS", DEFAULTS.startLookbackLedgers),
    cursorFile: c.optional("CURSOR_FILE") ?? DEFAULTS.cursorFile,
    lockFile: c.optional("LOCK_FILE") ?? DEFAULTS.lockFile,
    statusFile: c.optional("STATUS_FILE") ?? DEFAULTS.statusFile,
    maxNotificationsPerCycle: c.integer(
      "MAX_NOTIFICATIONS_PER_CYCLE",
      DEFAULTS.maxNotificationsPerCycle,
    ),
    featureFlags: parseNotificationFeatureFlags(c),
    auditFile: c.optional("AUDIT_FILE") ?? DEFAULTS.auditFile,
    dedupWindow: c.integer("DEDUP_WINDOW", DEFAULTS.dedupWindow),
    healthHost: c.optional("HEALTH_HOST") ?? defaultHealthHost(),
    healthPort: c.integer("HEALTH_PORT", defaultHealthPort()),
    healthStaleMs: c.integer("HEALTH_STALE_MS", DEFAULTS.healthStaleMs),
    startupHealthDeadlineMs: c.integer(
      "STARTUP_HEALTH_DEADLINE_MS",
      DEFAULTS.startupHealthDeadlineMs,
    ),
    startupHealthRetryMs: c.integer("STARTUP_HEALTH_RETRY_MS", DEFAULTS.startupHealthRetryMs),
    shutdownTimeoutMs: c.integer("SHETDOWN_TIMEOUT_MS", DEFAULTS.shutdownTimeoutMs),
    telegramSendTimeoutMs: c.integer(
      "TELEGRAM_SEND_TIMEOUT_MS",
      DEFAULTS.telegramSendTimeoutMs,
    ),
    channelPreviewMode: c.boolean("CHANNEL_PREVIEW_MODE", DEFAULTS.channelPreviewMode),
  };

  if (c.problems.length > 0) {
    throw new ConfigError(c.problems);
  }
  return config;
}

/** Origin of a configuration value, for boot logs and `/health`. */
export type ConfigSource = "environment" | "env-file" | "profile" | "default" | "derived";

export interface ConfigProvenanceEntry {
  name: string;
  source: ConfigSource;
}

/**
 * Reports which source supplied each setting. Names and origins only — no
 * values, secret or not, are ever returned. Safe to log and to serve from
 * `/health`.
 */
export function configProvenance(): ConfigProvenanceEntry[] {
  const profile = resolveProfileDefaults();
  const names = [
    "MARKET_CONTRACT_ID",
    "SQUAD_CONTRACT_ID",
    "STELLAR_RPC_URL",
    "STELLAR_HORIZON_URL",
    "STELLAR_NETWORK_PASSPHRASE",
    "EXPLORER_BASE_URL",
    "BOT_TOKEN",
    "TELEGRAM_CHAT_ID",
    "MARKET_CHAT_ID",
    "SQUAD_CHAT_ID",
    "ALLOWED_CHAT_IDS",
    "OPERATOR_TELEGRAM_USER_ID",
    "POLL_INTERVAL_MS",
    "START_LOOKBACK_LEDGERS",
    "CURSOR_FILE",
    "LOCK_FILE",
    "STATUS_FILE",
    "MAX_NOTIFICATIONS_PER_CYCLE",
    "AUDIT_FILE",
    "DEDUP_WINDOW",
    "HEALTH_HOST",
    "HEALTH_PORT",
    "HEALTH_STALE_MS",
    "STARTUP_HEALTH_DEADLINE_MS",
    "STARTUP_HEALTH_RETRY_MS",
    "SHUTDOWN_TIMEOUT_MS",
    "TELEGRAM_SEND_TIMEOUT_MS",
    "CHANNEL_PREVIEW_MODE",
  ];

  const environment = new Set(Object.keys(process.env));
  const result: ConfigProvenanceEntry[] = [];

  for (const name of names) {
    let source: ConfigSource;
    if (ENV_FILE.supplied.has(name)) {
      source = "env-file";
    } else if (environment.has(name)) {
      source = "environment";
    } else if (Object.prototype.hasOwnProperty.call(profile, name)) {
      source = "profile";
    } else {
      source = "default";
    }
    result.push({ name, source });
  }

  return result;
}
