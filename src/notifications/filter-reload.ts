/**
 * Atomic filter configuration validation and live reload store.
 *
 * Validates the entire candidate filter configuration (expression rules,
 * USDC amount thresholds, coarse feature flags, and claim category allowlist)
 * before swapping the active immutable rule set. Any syntax, type, range, JSON,
 * or file I/O failure retains the previous working filter set untouched.
 */

import { promises as fs } from "node:fs";
import type { DecodedEvent } from "../stellar/decode.js";
import {
  meetsThreshold,
  validateAmountThresholds,
  type AmountThresholds,
  type RawAmountThresholds,
} from "./amount-threshold.js";
import {
  DEFAULT_FEATURE_FLAGS,
  isNotificationAllowed,
  parseBoolFlag,
  type NotificationFeatureFlags,
} from "./featureFlags.js";
import {
  evaluateFilterRule,
  parseFilterExpression,
  type ExprNode,
  type FilterRule,
} from "./filter-expr.js";

export type FilterRuleMatchMode = "any" | "all";

export interface CandidateFeatureFlagsInput {
  enabled?: boolean | string;
  market?: boolean | string;
  squad?: boolean | string;
}

export interface CandidateFilterConfig {
  /** Filter expression strings compiled via {@link parseFilterExpression}. */
  rules?: readonly string[];
  /** Combination semantics when multiple `rules` are present (`"any"` default). */
  ruleMode?: FilterRuleMatchMode;
  /** Optional USDC amount thresholds (`marketChallenge`, `squadDeposit`). */
  thresholds?: RawAmountThresholds;
  /** Optional coarse notification gates (`enabled`, `market`, `squad`). */
  featureFlags?: CandidateFeatureFlagsInput;
  /** Optional `claim_created` category allowlist tokens. */
  categories?: readonly string[];
}

export interface CompiledFilterSet {
  readonly version: number;
  readonly loadedAt: number;
  readonly rules: readonly FilterRule[];
  readonly ruleMode: FilterRuleMatchMode;
  readonly thresholds: Readonly<AmountThresholds>;
  readonly featureFlags: Readonly<NotificationFeatureFlags>;
  readonly categories: readonly string[];
}

export class FilterConfigValidationError extends Error {
  readonly code = "FILTER_CONFIG_VALIDATION_ERROR" as const;
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      `Invalid filter configuration (${problems.length} problem${problems.length === 1 ? "" : "s"}):\n` +
        problems.map((p) => `  - ${p}`).join("\n"),
    );
    this.name = "FilterConfigValidationError";
    this.problems = [...problems];
  }
}

export type FilterValidationResult =
  | {
      ok: true;
      compiled: Omit<CompiledFilterSet, "version" | "loadedAt">;
    }
  | {
      ok: false;
      problems: string[];
    };

export type FilterReloadResult =
  | {
      ok: true;
      previousVersion: number;
      version: number;
      active: CompiledFilterSet;
    }
  | {
      ok: false;
      version: number;
      problems: string[];
      active: CompiledFilterSet;
    };

export interface AtomicFilterStoreStatus {
  version: number;
  loadedAt: number;
  reloadAttempts: number;
  failedReloads: number;
  lastReloadError: string | null;
  ruleCount: number;
}

export interface AtomicFilterStore {
  /** Current active immutable filter snapshot. */
  current(): CompiledFilterSet;
  /** Evaluates the active filter snapshot against a decoded event. */
  allows(event: DecodedEvent): boolean;
  /** Metadata about active version and reload diagnostics. */
  status(): AtomicFilterStoreStatus;
  /** Atomically validates and swaps a candidate config object. */
  reload(candidate: unknown): FilterReloadResult;
  /** Atomically parses JSON, validates, and swaps a candidate config. */
  reloadFromJson(rawJson: string): FilterReloadResult;
  /** Atomically reads a UTF-8 JSON file, validates, and swaps a candidate config. */
  reloadFromFile(filePath: string): Promise<FilterReloadResult>;
}

const KNOWN_CONFIG_KEYS = new Set([
  "rules",
  "ruleMode",
  "thresholds",
  "featureFlags",
  "categories",
]);

const KNOWN_FLAG_KEYS = new Set(["enabled", "market", "squad"]);

function freezeExprNode(node: ExprNode): ExprNode {
  if (node.type === "logical") {
    freezeExprNode(node.left);
    freezeExprNode(node.right);
    return Object.freeze(node);
  }
  Object.freeze(node.value);
  return Object.freeze(node);
}

function freezeFilterRule(rule: FilterRule): FilterRule {
  if (rule.condition) {
    freezeExprNode(rule.condition);
  }
  return Object.freeze(rule);
}

function validateFeatureFlagsInput(
  raw: unknown,
): { flags: NotificationFeatureFlags; problems: string[] } {
  const problems: string[] = [];
  if (raw === undefined || raw === null) {
    return { flags: { ...DEFAULT_FEATURE_FLAGS }, problems };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return {
      flags: { ...DEFAULT_FEATURE_FLAGS },
      problems: ["featureFlags must be an object with optional enabled, market, squad keys"],
    };
  }

  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!KNOWN_FLAG_KEYS.has(key)) {
      problems.push(`featureFlags.${key}: unknown feature flag key`);
    }
  }

  const resolved: NotificationFeatureFlags = { ...DEFAULT_FEATURE_FLAGS };
  for (const key of ["enabled", "market", "squad"] as const) {
    const val = record[key];
    if (val === undefined) continue;
    if (typeof val === "boolean") {
      resolved[key] = val;
      continue;
    }
    if (typeof val === "string") {
      const parsed = parseBoolFlag(`featureFlags.${key}`, val, DEFAULT_FEATURE_FLAGS[key]);
      if (parsed.problems.length > 0) {
        problems.push(...parsed.problems);
      } else {
        resolved[key] = parsed.value;
      }
      continue;
    }
    problems.push(`featureFlags.${key} must be a boolean or boolean string, got ${typeof val}`);
  }

  return { flags: resolved, problems };
}

/**
 * Validates the complete candidate filter configuration upfront without side effects.
 * Collects every problem across rules, ruleMode, thresholds, featureFlags, and categories.
 */
export function validateCandidateFilterConfig(candidate: unknown): FilterValidationResult {
  if (candidate === null || candidate === undefined || typeof candidate !== "object" || Array.isArray(candidate)) {
    return {
      ok: false,
      problems: ["Filter configuration must be a JSON object"],
    };
  }

  const record = candidate as Record<string, unknown>;
  const problems: string[] = [];

  for (const key of Object.keys(record)) {
    if (!KNOWN_CONFIG_KEYS.has(key)) {
      problems.push(`Unknown filter configuration key "${key}"`);
    }
  }

  // 1. Validate ruleMode
  let ruleMode: FilterRuleMatchMode = "any";
  if (record.ruleMode !== undefined) {
    if (record.ruleMode === "any" || record.ruleMode === "all") {
      ruleMode = record.ruleMode;
    } else {
      problems.push(`ruleMode must be "any" or "all"; got ${JSON.stringify(record.ruleMode)}`);
    }
  }

  // 2. Validate every filter expression rule
  const compiledRules: FilterRule[] = [];
  if (record.rules !== undefined) {
    if (!Array.isArray(record.rules)) {
      problems.push("rules must be an array of filter expression strings");
    } else {
      for (let i = 0; i < record.rules.length; i++) {
        const entry = record.rules[i];
        if (typeof entry !== "string" || entry.trim() === "") {
          problems.push(`rules[${i}]: filter expression must be a non-empty string`);
          continue;
        }
        try {
          compiledRules.push(freezeFilterRule(parseFilterExpression(entry)));
        } catch (err) {
          problems.push(`rules[${i}]: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  // 3. Validate thresholds
  const thresholdsValidated = validateAmountThresholds(record.thresholds);
  problems.push(...thresholdsValidated.problems);

  // 4. Validate featureFlags
  const flagsValidated = validateFeatureFlagsInput(record.featureFlags);
  problems.push(...flagsValidated.problems);

  // 5. Validate categories
  const normalizedCategories: string[] = [];
  if (record.categories !== undefined) {
    if (!Array.isArray(record.categories)) {
      problems.push("categories must be an array of category strings");
    } else {
      const seen = new Set<string>();
      for (let i = 0; i < record.categories.length; i++) {
        const cat = record.categories[i];
        if (typeof cat !== "string") {
          problems.push(`categories[${i}]: category must be a string, got ${typeof cat}`);
          continue;
        }
        const cleaned = cat.trim().toLowerCase();
        if (cleaned.length > 0 && !seen.has(cleaned)) {
          seen.add(cleaned);
          normalizedCategories.push(cleaned);
        }
      }
    }
  }

  if (problems.length > 0) {
    return { ok: false, problems };
  }

  return {
    ok: true,
    compiled: {
      rules: Object.freeze(compiledRules),
      ruleMode,
      thresholds: Object.freeze({ ...thresholdsValidated.thresholds }),
      featureFlags: Object.freeze({ ...flagsValidated.flags }),
      categories: Object.freeze(normalizedCategories),
    },
  };
}

/**
 * Evaluates an immutable {@link CompiledFilterSet} against a {@link DecodedEvent}.
 */
export function evaluateCompiledFilterSet(
  filterSet: CompiledFilterSet,
  event: DecodedEvent,
): boolean {
  if (!isNotificationAllowed(filterSet.featureFlags, event.source, event.payload.name)) {
    return false;
  }

  if (filterSet.categories.length > 0 && event.payload.name === "claim_created") {
    const category = String(event.payload.category ?? "").trim().toLowerCase();
    if (!filterSet.categories.includes(category)) {
      return false;
    }
  }

  if (!meetsThreshold(event, filterSet.thresholds)) {
    return false;
  }

  if (filterSet.rules.length > 0) {
    if (filterSet.ruleMode === "all") {
      return filterSet.rules.every((rule) => evaluateFilterRule(rule, event));
    }
    return filterSet.rules.some((rule) => evaluateFilterRule(rule, event));
  }

  return true;
}

/**
 * Creates a live-reloadable filter configuration store that validates the full
 * candidate configuration before atomically swapping the active rule set.
 */
export function createAtomicFilterStore(
  initialConfig: CandidateFilterConfig = {},
  options: { now?: () => number } = {},
): AtomicFilterStore {
  const now = options.now ?? Date.now;
  const initialValidation = validateCandidateFilterConfig(initialConfig);
  if (!initialValidation.ok) {
    throw new FilterConfigValidationError(initialValidation.problems);
  }

  let active: CompiledFilterSet = Object.freeze({
    version: 1,
    loadedAt: now(),
    ...initialValidation.compiled,
  });

  let reloadAttempts = 0;
  let failedReloads = 0;
  let lastReloadError: string | null = null;
  let fileReloadQueue: Promise<unknown> = Promise.resolve();

  function failReload(problems: string[]): FilterReloadResult {
    reloadAttempts++;
    failedReloads++;
    lastReloadError = problems.join("; ");
    return {
      ok: false,
      version: active.version,
      problems: [...problems],
      active,
    };
  }

  function reload(candidate: unknown): FilterReloadResult {
    const validation = validateCandidateFilterConfig(candidate);
    if (!validation.ok) {
      return failReload(validation.problems);
    }

    reloadAttempts++;
    lastReloadError = null;
    const previousVersion = active.version;
    const nextSet: CompiledFilterSet = Object.freeze({
      version: previousVersion + 1,
      loadedAt: now(),
      ...validation.compiled,
    });
    active = nextSet;

    return {
      ok: true,
      previousVersion,
      version: nextSet.version,
      active: nextSet,
    };
  }

  function reloadFromJson(rawJson: string): FilterReloadResult {
    if (typeof rawJson !== "string") {
      return failReload([`Filter configuration JSON must be a string, got ${typeof rawJson}`]);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawJson);
    } catch (err) {
      return failReload([
        `Invalid filter configuration JSON: ${err instanceof Error ? err.message : String(err)}`,
      ]);
    }
    return reload(parsed);
  }

  function reloadFromFile(filePath: string): Promise<FilterReloadResult> {
    const run = async (): Promise<FilterReloadResult> => {
      let raw: string;
      try {
        raw = await fs.readFile(filePath, "utf8");
      } catch (err) {
        return failReload([
          `Failed to read filter configuration file: ${err instanceof Error ? err.message : String(err)}`,
        ]);
      }
      return reloadFromJson(raw);
    };

    const queued = fileReloadQueue.then(run, run);
    fileReloadQueue = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  return {
    current(): CompiledFilterSet {
      return active;
    },
    allows(event: DecodedEvent): boolean {
      return evaluateCompiledFilterSet(active, event);
    },
    status(): AtomicFilterStoreStatus {
      return {
        version: active.version,
        loadedAt: active.loadedAt,
        reloadAttempts,
        failedReloads,
        lastReloadError,
        ruleCount: active.rules.length,
      };
    },
    reload,
    reloadFromJson,
    reloadFromFile,
  };
}
