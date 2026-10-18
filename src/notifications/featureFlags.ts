/**
 * Notification feature flags.
 *
 * Coarse boolean gates for Telegram posts so operators can quiet the bot
 * (or one contract source) during incidents without stopping the poller or
 * rewriting event-level config. Disabled notifications are skip-logged and
 * counted; the cursor still advances. The chain remains the source of truth.
 *
 * Distinct from per-event suppression: these flags are source-/global-scoped
 * kill switches, not a name allowlist.
 */

import fs from "node:fs";
import type { ContractSource } from "../stellar/decode.js";

export interface NotificationFeatureFlags {
  /** Master kill switch. When false, no Telegram posts are attempted. */
  enabled: boolean;
  /** Post notifiable mimir-market events. */
  market: boolean;
  /** Post notifiable mimir-squad events. */
  squad: boolean;
}

export const DEFAULT_FEATURE_FLAGS: NotificationFeatureFlags = {
  enabled: true,
  market: true,
  squad: true,
};

export interface ParsedFeatureFlags {
  flags: NotificationFeatureFlags;
  problems: string[];
}

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off"]);

/**
 * Parse a single boolean env flag.
 *
 * Bounded behavior:
 * - unset / blank → default
 * - surrounding whitespace ignored
 * - matching is case-insensitive
 * - unknown tokens become problems (fail-fast at boot) so typos never silently
 *   flip a gate
 */
export function parseBoolFlag(
  name: string,
  raw: string | undefined,
  fallback: boolean,
): { value: boolean; problems: string[] } {
  const problems: string[] = [];
  if (raw === undefined) return { value: fallback, problems };
  const trimmed = raw.trim();
  if (trimmed === "") return { value: fallback, problems };

  const normalized = trimmed.toLowerCase();
  if (TRUTHY.has(normalized)) return { value: true, problems };
  if (FALSY.has(normalized)) return { value: false, problems };

  problems.push(
    `${name} must be a boolean (true/false, 1/0, yes/no, on/off); got "${trimmed}"`,
  );
  return { value: fallback, problems };
}

/**
 * Load notification feature flags from env-shaped inputs.
 *
 * Env mapping:
 * - `NOTIFY_ENABLED` → master gate (default true)
 * - `NOTIFY_MARKET` → market-source gate (default true)
 * - `NOTIFY_SQUAD` → squad-source gate (default true)
 */
export function parseNotificationFeatureFlags(env: {
  NOTIFY_ENABLED?: string;
  NOTIFY_MARKET?: string;
  NOTIFY_SQUAD?: string;
}): ParsedFeatureFlags {
  const problems: string[] = [];

  const enabled = parseBoolFlag(
    "NOTIFY_ENABLED",
    env.NOTIFY_ENABLED,
    DEFAULT_FEATURE_FLAGS.enabled,
  );
  const market = parseBoolFlag(
    "NOTIFY_MARKET",
    env.NOTIFY_MARKET,
    DEFAULT_FEATURE_FLAGS.market,
  );
  const squad = parseBoolFlag(
    "NOTIFY_SQUAD",
    env.NOTIFY_SQUAD,
    DEFAULT_FEATURE_FLAGS.squad,
  );

  problems.push(...enabled.problems, ...market.problems, ...squad.problems);

  return {
    flags: {
      enabled: enabled.value,
      market: market.value,
      squad: squad.value,
    },
    problems,
  };
}

// In-memory layer holding runtime overrides on top of env flags
let activeOverrides: Partial<NotificationFeatureFlags> = {};
let persistenceFilePath: string | null = null;

export function setPersistencePath(filePath: string | null): void {
  persistenceFilePath = filePath;
  if (persistenceFilePath) {
    try {
      if (fs.existsSync(persistenceFilePath)) {
        const content = fs.readFileSync(persistenceFilePath, "utf8");
        const parsed = JSON.parse(content);
        if (parsed && typeof parsed === "object") {
          activeOverrides = {};
          if (typeof parsed.enabled === "boolean") activeOverrides.enabled = parsed.enabled;
          if (typeof parsed.market === "boolean") activeOverrides.market = parsed.market;
          if (typeof parsed.squad === "boolean") activeOverrides.squad = parsed.squad;
        }
      }
    } catch {
      // Ignored for resilience
    }
  }
}

export function getFlagOverrides(): Partial<NotificationFeatureFlags> {
  return { ...activeOverrides };
}

export function setFlagOverride(
  flag: keyof NotificationFeatureFlags,
  value: boolean,
): void {
  activeOverrides[flag] = value;
  if (persistenceFilePath) {
    try {
      fs.writeFileSync(persistenceFilePath, JSON.stringify(activeOverrides, null, 2), "utf8");
    } catch {
      // Ignored for resilience
    }
  }
}

export function clearFlagOverrides(): void {
  activeOverrides = {};
  if (persistenceFilePath) {
    try {
      if (fs.existsSync(persistenceFilePath)) {
        fs.unlinkSync(persistenceFilePath);
      }
    } catch {
      // Ignored for resilience
    }
  }
}

export function getEffectiveFeatureFlags(
  flagsOrUndefined: NotificationFeatureFlags | undefined,
): NotificationFeatureFlags {
  const base = flagsOrUndefined ?? DEFAULT_FEATURE_FLAGS;
  return {
    ...base,
    ...activeOverrides,
  };
}

/**
 * Whether a decoded event from `source` may be posted under the active flags.
 * Event name is accepted for future fine-grained gates; today the decision is
 * source-scoped once the master switch is on.
 */
export function isNotificationAllowed(
  flagsOrUndefined: NotificationFeatureFlags | undefined,
  source: ContractSource,
  _eventName?: string,
): boolean {
  // Consult effective flags with active overrides applied
  const flags = getEffectiveFeatureFlags(flagsOrUndefined);
  if (!flags.enabled) return false;
  if (source === "market") return flags.market;
  if (source === "squad") return flags.squad;
  return false;
}

/** Stable, secret-free summary for boot logs and `/status`. */
export function formatFeatureFlags(
  flagsOrUndefined: NotificationFeatureFlags | undefined,
): string {
  const flags = getEffectiveFeatureFlags(flagsOrUndefined);
  return (
    `enabled=${flags.enabled} market=${flags.market} squad=${flags.squad}`
  );
}

