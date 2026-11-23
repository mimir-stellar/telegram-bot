/**
 * Per-route notification filter overrides.
 *
 * Extends the typed filter expression parser (`filter-expr.ts`) and integer
 * USDC amount thresholds (`amount-threshold.ts`) so operators can attach
 * route-specific overrides on top of a global baseline policy.
 *
 * Precedence rules:
 * 1. Route disabled (`enabled: false`): always suppresses notifications for that route.
 * 2. Effective thresholds:
 *    - `mode: "merge"` (default): route threshold fields override the corresponding
 *      global threshold fields when explicitly provided (including `0n` / `"0"` to
 *      disable a global threshold for that route). Unspecified fields inherit global.
 *    - `mode: "replace"`: route thresholds completely replace global thresholds.
 * 3. Effective filter expressions:
 *    - `mode: "merge"` (default): global expressions (if non-empty) must match AND
 *      route expressions (if non-empty) must match. Within a single expression list,
 *      matching any rule satisfies that list (OR semantics).
 *    - `mode: "replace"`: route expressions completely replace global expressions.
 *
 * Fault isolation:
 * - Invalid per-route overrides are isolated to the affected route and recorded in
 *   `registry.invalidRoutes`. They never break compilation or evaluation of the
 *   global policy or any other route.
 * - By default (`invalidRouteFallback: "global"`), an affected route safely falls
 *   back to the global policy. Operators may opt into `invalidRouteFallback: "deny"`
 *   to fail closed for affected routes.
 */

import type { DecodedEvent } from "../stellar/decode.js";
import {
  InvalidThresholdError,
  meetsThreshold,
  parseUsdcThreshold,
  type AmountThresholds,
} from "./amount-threshold.js";
import {
  evaluateFilterRule,
  FilterDepthLimitError,
  FilterParseError,
  FilterTokenLimitError,
  parseFilterExpression,
  type FilterParserOptions,
  type FilterRule,
} from "./filter-expr.js";

/** How a route override combines with the global filter policy. */
export type RouteOverrideMode = "merge" | "replace";

/** Fallback behavior for a route whose override failed validation. */
export type InvalidRouteFallback = "global" | "deny";

/** Raw threshold configuration accepting decimal USDC strings or atomic bigints. */
export interface RawThresholdConfig {
  /** Minimum stake for `claim_challenged` (market). `"0"` or `0n` disables. */
  marketChallenge?: string | bigint;
  /** Minimum amount for `deposited` (squad). `"0"` or `0n` disables. */
  squadDeposit?: string | bigint;
}

/** Raw filter policy (used for global baseline and as base for route overrides). */
export interface RawFilterPolicy {
  /** Filter expression strings parsed via {@link parseFilterExpression}. */
  expressions?: readonly string[];
  /** Amount thresholds parsed via {@link parseUsdcThreshold} (or atomic bigint). */
  thresholds?: RawThresholdConfig;
  /** Optional parser safety bounds (`maxTokens`, `maxDepth`). */
  parserOptions?: FilterParserOptions;
}

/** Per-route filter override definition. */
export interface RawRouteFilterOverride extends RawFilterPolicy {
  /**
   * How this override combines with the global policy.
   * Defaults to `"merge"`.
   */
  mode?: RouteOverrideMode;
  /**
   * Whether notifications are enabled for this route.
   * When `false`, all events are suppressed for this route. Defaults to `true`.
   */
  enabled?: boolean;
}

/** Top-level configuration for global and per-route notification filters. */
export interface RouteFilterConfig {
  /** Global baseline filter policy applied to all routes by default. */
  global?: RawFilterPolicy;
  /** Per-route overrides keyed by route identifier (e.g. chat ID or named route). */
  routes?: Record<string, RawRouteFilterOverride>;
}

/** Options controlling compilation and invalid-override fallback behavior. */
export interface CompileRouteFiltersOptions {
  /**
   * Behavior when evaluating an event for a route whose override was invalid.
   * - `"global"` (default): fall back to the compiled global policy.
   * - `"deny"`: suppress notifications for the affected route.
   */
  invalidRouteFallback?: InvalidRouteFallback;
}

/** Structured validation issue for a single field in a filter policy. */
export interface FilterValidationIssue {
  field: string;
  message: string;
  cause?: unknown;
}

/** Error thrown when a global filter policy (or standalone policy) fails validation. */
export class RouteFilterValidationError extends Error {
  public readonly scope: string;
  public readonly issues: readonly FilterValidationIssue[];

  constructor(scope: string, issues: readonly FilterValidationIssue[]) {
    const summary = issues.map((i) => `${i.field}: ${i.message}`).join("; ");
    super(`Invalid filter configuration for ${scope}: ${summary}`);
    this.name = "RouteFilterValidationError";
    this.scope = scope;
    this.issues = Object.freeze([...issues]);
  }
}

/** Diagnostic recorded when a route override fails validation and is isolated. */
export interface RouteOverrideDiagnostic {
  readonly routeId: string;
  readonly message: string;
  readonly issues: readonly FilterValidationIssue[];
}

/** Immutable compiled filter policy (expressions + integer USDC thresholds). */
export interface CompiledFilterPolicy {
  readonly rules: readonly FilterRule[];
  readonly thresholds: Readonly<AmountThresholds>;
}

/** Immutable compiled entry for a single valid route override. */
export interface CompiledRouteOverride {
  readonly routeId: string;
  readonly mode: RouteOverrideMode;
  readonly enabled: boolean;
  readonly policy: CompiledFilterPolicy;
  readonly effectiveThresholds: Readonly<AmountThresholds>;
}

/** Result of evaluating a single event for a specific route. */
export interface RouteFilterDecision {
  readonly routeId: string;
  readonly allowed: boolean;
  readonly reason:
    | "allowed"
    | "route_disabled"
    | "threshold_not_met"
    | "global_expression_mismatch"
    | "route_expression_mismatch"
    | "invalid_override_denied";
  readonly overrideStatus:
    | "none"
    | "applied"
    | "invalid_fallback_global"
    | "invalid_denied";
  readonly effectiveMode: "global" | "merge" | "replace";
}

function parseThresholdValue(
  field: string,
  value: string | bigint,
): bigint {
  if (typeof value === "bigint") {
    if (value < 0n) {
      throw new InvalidThresholdError(`Threshold ${field} cannot be negative: ${value}`);
    }
    return value;
  }
  return parseUsdcThreshold(value);
}

/**
 * Compiles and validates a standalone {@link RawFilterPolicy}.
 * Collects all validation issues before throwing {@link RouteFilterValidationError}.
 */
export function compileFilterPolicy(
  raw?: RawFilterPolicy,
  scope = "global",
): CompiledFilterPolicy {
  if (!raw) {
    return Object.freeze({
      rules: Object.freeze([]),
      thresholds: Object.freeze({}),
    });
  }

  const issues: FilterValidationIssue[] = [];
  const rules: FilterRule[] = [];
  const thresholds: AmountThresholds = {};

  if (raw.expressions !== undefined) {
    if (!Array.isArray(raw.expressions)) {
      issues.push({
        field: "expressions",
        message: "expressions must be an array of filter expression strings",
      });
    } else {
      for (let i = 0; i < raw.expressions.length; i++) {
        const expr = raw.expressions[i];
        if (typeof expr !== "string" || expr.trim() === "") {
          issues.push({
            field: `expressions[${i}]`,
            message: "Filter expression must be a non-empty string",
          });
          continue;
        }
        try {
          rules.push(parseFilterExpression(expr, raw.parserOptions));
        } catch (err) {
          const message =
            err instanceof FilterParseError ||
            err instanceof FilterTokenLimitError ||
            err instanceof FilterDepthLimitError ||
            err instanceof Error
              ? err.message
              : String(err);
          issues.push({
            field: `expressions[${i}]`,
            message,
            cause: err,
          });
        }
      }
    }
  }

  if (raw.thresholds !== undefined) {
    if (raw.thresholds === null || typeof raw.thresholds !== "object" || Array.isArray(raw.thresholds)) {
      issues.push({
        field: "thresholds",
        message: "thresholds must be an object",
      });
    } else {
      if (raw.thresholds.marketChallenge !== undefined) {
        try {
          thresholds.marketChallenge = parseThresholdValue(
            "thresholds.marketChallenge",
            raw.thresholds.marketChallenge,
          );
        } catch (err) {
          issues.push({
            field: "thresholds.marketChallenge",
            message: err instanceof Error ? err.message : String(err),
            cause: err,
          });
        }
      }
      if (raw.thresholds.squadDeposit !== undefined) {
        try {
          thresholds.squadDeposit = parseThresholdValue(
            "thresholds.squadDeposit",
            raw.thresholds.squadDeposit,
          );
        } catch (err) {
          issues.push({
            field: "thresholds.squadDeposit",
            message: err instanceof Error ? err.message : String(err),
            cause: err,
          });
        }
      }
    }
  }

  if (issues.length > 0) {
    throw new RouteFilterValidationError(scope, issues);
  }

  return Object.freeze({
    rules: Object.freeze(rules),
    thresholds: Object.freeze(thresholds),
  });
}

function mergeThresholds(
  globalThresholds: Readonly<AmountThresholds>,
  routeThresholds: Readonly<AmountThresholds>,
  mode: RouteOverrideMode,
): Readonly<AmountThresholds> {
  if (mode === "replace") {
    return Object.freeze({ ...routeThresholds });
  }
  const merged: AmountThresholds = { ...globalThresholds };
  if (routeThresholds.marketChallenge !== undefined) {
    merged.marketChallenge = routeThresholds.marketChallenge;
  }
  if (routeThresholds.squadDeposit !== undefined) {
    merged.squadDeposit = routeThresholds.squadDeposit;
  }
  return Object.freeze(merged);
}

function matchesAnyRule(rules: readonly FilterRule[], event: DecodedEvent): boolean {
  if (rules.length === 0) {
    return true;
  }
  return rules.some((rule) => evaluateFilterRule(rule, event));
}

/**
 * Compiled registry holding the global filter policy, valid per-route overrides,
 * and isolated diagnostics for any invalid route overrides.
 */
export class CompiledRouteFilterRegistry {
  public readonly global: CompiledFilterPolicy;
  public readonly routes: ReadonlyMap<string, CompiledRouteOverride>;
  public readonly invalidRoutes: ReadonlyMap<string, RouteOverrideDiagnostic>;
  public readonly invalidRouteFallback: InvalidRouteFallback;

  constructor(
    globalPolicy: CompiledFilterPolicy,
    routes: Map<string, CompiledRouteOverride>,
    invalidRoutes: Map<string, RouteOverrideDiagnostic>,
    invalidRouteFallback: InvalidRouteFallback,
  ) {
    this.global = globalPolicy;
    this.routes = routes;
    this.invalidRoutes = invalidRoutes;
    this.invalidRouteFallback = invalidRouteFallback;
  }

  /**
   * Evaluates whether `event` should be delivered to `routeId` and returns
   * a structured {@link RouteFilterDecision} explaining the outcome.
   */
  public evaluate(routeId: string, event: DecodedEvent): RouteFilterDecision {
    const normalizedId = routeId.trim();

    // 1. Check if this route had an isolated invalid override
    if (this.invalidRoutes.has(normalizedId)) {
      if (this.invalidRouteFallback === "deny") {
        return {
          routeId: normalizedId,
          allowed: false,
          reason: "invalid_override_denied",
          overrideStatus: "invalid_denied",
          effectiveMode: "global",
        };
      }
      return this.evaluateGlobal(normalizedId, event, "invalid_fallback_global");
    }

    // 2. Check if this route has a valid override
    const override = this.routes.get(normalizedId);
    if (!override) {
      return this.evaluateGlobal(normalizedId, event, "none");
    }

    // 3. Route-level kill switch wins over all rules
    if (!override.enabled) {
      return {
        routeId: normalizedId,
        allowed: false,
        reason: "route_disabled",
        overrideStatus: "applied",
        effectiveMode: override.mode,
      };
    }

    // 4. Evaluate effective thresholds
    if (!meetsThreshold(event, override.effectiveThresholds)) {
      return {
        routeId: normalizedId,
        allowed: false,
        reason: "threshold_not_met",
        overrideStatus: "applied",
        effectiveMode: override.mode,
      };
    }

    // 5. Evaluate expressions according to override mode
    if (override.mode === "replace") {
      if (!matchesAnyRule(override.policy.rules, event)) {
        return {
          routeId: normalizedId,
          allowed: false,
          reason: "route_expression_mismatch",
          overrideStatus: "applied",
          effectiveMode: "replace",
        };
      }
      return {
        routeId: normalizedId,
        allowed: true,
        reason: "allowed",
        overrideStatus: "applied",
        effectiveMode: "replace",
      };
    }

    // mode === "merge": global expressions (if any) AND route expressions (if any) must pass
    if (!matchesAnyRule(this.global.rules, event)) {
      return {
        routeId: normalizedId,
        allowed: false,
        reason: "global_expression_mismatch",
        overrideStatus: "applied",
        effectiveMode: "merge",
      };
    }

    if (!matchesAnyRule(override.policy.rules, event)) {
      return {
        routeId: normalizedId,
        allowed: false,
        reason: "route_expression_mismatch",
        overrideStatus: "applied",
        effectiveMode: "merge",
      };
    }

    return {
      routeId: normalizedId,
      allowed: true,
      reason: "allowed",
      overrideStatus: "applied",
      effectiveMode: "merge",
    };
  }

  /** Convenience boolean check for whether `event` should be sent to `routeId`. */
  public shouldNotify(routeId: string, event: DecodedEvent): boolean {
    return this.evaluate(routeId, event).allowed;
  }

  /** Evaluates `event` across multiple routes in order. */
  public evaluateAll(
    routeIds: readonly string[],
    event: DecodedEvent,
  ): RouteFilterDecision[] {
    return routeIds.map((id) => this.evaluate(id, event));
  }

  private evaluateGlobal(
    routeId: string,
    event: DecodedEvent,
    overrideStatus: "none" | "invalid_fallback_global",
  ): RouteFilterDecision {
    if (!meetsThreshold(event, this.global.thresholds)) {
      return {
        routeId,
        allowed: false,
        reason: "threshold_not_met",
        overrideStatus,
        effectiveMode: "global",
      };
    }
    if (!matchesAnyRule(this.global.rules, event)) {
      return {
        routeId,
        allowed: false,
        reason: "global_expression_mismatch",
        overrideStatus,
        effectiveMode: "global",
      };
    }
    return {
      routeId,
      allowed: true,
      reason: "allowed",
      overrideStatus,
      effectiveMode: "global",
    };
  }
}

/**
 * Compiles a {@link RouteFilterConfig} into an immutable {@link CompiledRouteFilterRegistry}.
 *
 * - An invalid `global` policy throws {@link RouteFilterValidationError}.
 * - An invalid per-route override is isolated to that route, recorded in
 *   `registry.invalidRoutes`, and does not prevent other routes or the global
 *   policy from compiling and operating normally.
 */
export function compileRouteFilters(
  config: RouteFilterConfig = {},
  options: CompileRouteFiltersOptions = {},
): CompiledRouteFilterRegistry {
  const invalidRouteFallback: InvalidRouteFallback =
    options.invalidRouteFallback ?? "global";

  const globalPolicy = compileFilterPolicy(config.global, "global");
  const routes = new Map<string, CompiledRouteOverride>();
  const invalidRoutes = new Map<string, RouteOverrideDiagnostic>();

  if (config.routes) {
    for (const [rawRouteId, rawOverride] of Object.entries(config.routes)) {
      const routeId = rawRouteId.trim();
      if (routeId === "") {
        invalidRoutes.set(rawRouteId, {
          routeId: rawRouteId,
          message: "Route identifier cannot be empty",
          issues: Object.freeze([
            { field: "routeId", message: "Route identifier cannot be empty" },
          ]),
        });
        continue;
      }

      const routeIssues: FilterValidationIssue[] = [];

      if (rawOverride === null || typeof rawOverride !== "object" || Array.isArray(rawOverride)) {
        invalidRoutes.set(routeId, {
          routeId,
          message: `Invalid filter configuration for route "${routeId}": override must be an object`,
          issues: Object.freeze([
            { field: "override", message: "override must be an object" },
          ]),
        });
        continue;
      }

      const mode: RouteOverrideMode = rawOverride.mode ?? "merge";
      if (mode !== "merge" && mode !== "replace") {
        routeIssues.push({
          field: "mode",
          message: `Unsupported override mode "${String(mode)}" (expected "merge" or "replace")`,
        });
      }

      const enabled = rawOverride.enabled ?? true;
      if (typeof enabled !== "boolean") {
        routeIssues.push({
          field: "enabled",
          message: `enabled must be a boolean, got ${typeof enabled}`,
        });
      }

      let compiledPolicy: CompiledFilterPolicy | undefined;
      try {
        compiledPolicy = compileFilterPolicy(rawOverride, `route "${routeId}"`);
      } catch (err) {
        if (err instanceof RouteFilterValidationError) {
          routeIssues.push(...err.issues);
        } else {
          routeIssues.push({
            field: "override",
            message: err instanceof Error ? err.message : String(err),
            cause: err,
          });
        }
      }

      if (routeIssues.length > 0 || !compiledPolicy) {
        const summary = routeIssues.map((i) => `${i.field}: ${i.message}`).join("; ");
        invalidRoutes.set(routeId, {
          routeId,
          message: `Invalid filter configuration for route "${routeId}": ${summary}`,
          issues: Object.freeze(routeIssues),
        });
        continue;
      }

      const effectiveThresholds = mergeThresholds(
        globalPolicy.thresholds,
        compiledPolicy.thresholds,
        mode,
      );

      routes.set(
        routeId,
        Object.freeze({
          routeId,
          mode,
          enabled,
          policy: compiledPolicy,
          effectiveThresholds,
        }),
      );
    }
  }

  return new CompiledRouteFilterRegistry(
    globalPolicy,
    routes,
    invalidRoutes,
    invalidRouteFallback,
  );
}
