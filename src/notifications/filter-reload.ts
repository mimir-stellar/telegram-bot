/**
 * Atomic filter configuration reloader for notification filtering.
 *
 * Combines typed filter expressions ({@link parseFilterExpression}) and
 * integer USDC amount thresholds ({@link parseUsdcThreshold}) into a single
 * immutable {@link CompiledFilterSet}.
 *
 * Reloads validate the entire candidate configuration upfront before swapping
 * the active filter set reference. On any validation failure, the previous
 * working filter set is retained untouched.
 */

import type { DecodedEvent } from "../stellar/decode.js";
import {
  type AmountThresholds,
  meetsThreshold,
  parseUsdcThreshold,
} from "./amount-threshold.js";
import {
  evaluateFilterRule,
  type FilterParserOptions,
  type FilterRule,
  parseFilterExpression,
} from "./filter-expr.js";

/** A single validation problem found while compiling a candidate filter configuration. */
export interface FilterConfigValidationIssue {
  /** Dot/bracket path of the invalid field (e.g. "expressions[1]", "thresholds.marketChallenge"). */
  readonly field: string;
  /** Human-readable explanation of the validation failure. */
  readonly message: string;
  /** Underlying error thrown by the expression parser or threshold parser, if any. */
  readonly cause?: unknown;
}

/** Error thrown when a candidate filter configuration fails full validation. */
export class FilterConfigValidationError extends Error {
  public readonly issues: readonly FilterConfigValidationIssue[];

  constructor(issues: readonly FilterConfigValidationIssue[]) {
    const summary = issues
      .map((issue) => `${issue.field}: ${issue.message}`)
      .join("; ");
    super(`Invalid filter configuration (${issues.length} issue${issues.length === 1 ? "" : "s"}): ${summary}`);
    this.name = "FilterConfigValidationError";
    this.issues = Object.freeze([...issues]);
  }
}

/** Raw/unvalidated threshold values accepted in a reload candidate. */
export interface FilterThresholdCandidate {
  /** Minimum stake for `claim_challenged` (market), as a decimal USDC string or non-negative atomic bigint. */
  marketChallenge?: string | bigint;
  /** Minimum amount for `deposited` (squad), as a decimal USDC string or non-negative atomic bigint. */
  squadDeposit?: string | bigint;
}

/** Unvalidated candidate filter configuration submitted for compilation or reload. */
export interface FilterConfigCandidate {
  /** Raw filter expression strings parsed via {@link parseFilterExpression}. */
  expressions?: readonly string[];
  /** Optional parser limits applied when compiling `expressions`. */
  parserOptions?: FilterParserOptions;
  /** Optional amount thresholds parsed via {@link parseUsdcThreshold}. */
  thresholds?: FilterThresholdCandidate;
}

/** Immutable, validated snapshot of active notification filters. */
export interface CompiledFilterSet {
  /** Monotonically increasing revision number for successful compilations/swaps. */
  readonly version: number;
  /** Parsed and schema-validated filter rules. */
  readonly rules: readonly FilterRule[];
  /** Parsed and validated integer USDC amount thresholds. */
  readonly thresholds: Readonly<AmountThresholds>;
}

/** Result returned by {@link AtomicFilterReloader.reload}. */
export type FilterReloadResult =
  | {
      readonly ok: true;
      readonly applied: true;
      readonly version: number;
      readonly previousVersion: number;
      readonly filterSet: CompiledFilterSet;
    }
  | {
      readonly ok: false;
      readonly applied: false;
      readonly version: number;
      readonly error: FilterConfigValidationError;
      readonly filterSet: CompiledFilterSet;
    };

function parseThresholdValue(
  raw: unknown,
  field: string,
  issues: FilterConfigValidationIssue[],
): bigint | undefined {
  if (raw === undefined) {
    return undefined;
  }

  if (typeof raw === "bigint") {
    if (raw < 0n) {
      issues.push({
        field,
        message: `Threshold cannot be negative: ${raw.toString()}`,
      });
      return undefined;
    }
    return raw;
  }

  if (typeof raw === "string") {
    try {
      return parseUsdcThreshold(raw);
    } catch (err) {
      issues.push({
        field,
        message: err instanceof Error ? err.message : String(err),
        cause: err,
      });
      return undefined;
    }
  }

  issues.push({
    field,
    message: `Threshold must be a decimal string or non-negative bigint, got ${typeof raw}`,
  });
  return undefined;
}

/**
 * Validates and compiles a full {@link FilterConfigCandidate} into an immutable
 * {@link CompiledFilterSet}.
 *
 * All fields (every expression and every threshold) are validated before
 * returning or throwing so partial configurations are never produced.
 *
 * @throws {@link FilterConfigValidationError} if any part of the candidate is invalid.
 */
export function compileFilterConfig(
  candidate: FilterConfigCandidate,
  version = 0,
): CompiledFilterSet {
  const issues: FilterConfigValidationIssue[] = [];

  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new FilterConfigValidationError([
      {
        field: "candidate",
        message: "Filter configuration candidate must be a non-null object",
      },
    ]);
  }

  // Validate expressions
  const rules: FilterRule[] = [];
  if (candidate.expressions !== undefined) {
    if (!Array.isArray(candidate.expressions)) {
      issues.push({
        field: "expressions",
        message: "expressions must be an array of filter expression strings",
      });
    } else {
      for (let i = 0; i < candidate.expressions.length; i++) {
        const expr = candidate.expressions[i];
        const field = `expressions[${i}]`;
        if (typeof expr !== "string") {
          issues.push({
            field,
            message: `Filter expression must be a string, got ${typeof expr}`,
          });
          continue;
        }
        if (expr.trim() === "") {
          issues.push({
            field,
            message: "Filter expression must be a non-empty string",
          });
          continue;
        }
        try {
          rules.push(parseFilterExpression(expr, candidate.parserOptions));
        } catch (err) {
          issues.push({
            field,
            message: err instanceof Error ? err.message : String(err),
            cause: err,
          });
        }
      }
    }
  }

  // Validate thresholds
  const thresholds: AmountThresholds = {};
  if (candidate.thresholds !== undefined) {
    if (
      candidate.thresholds === null ||
      typeof candidate.thresholds !== "object" ||
      Array.isArray(candidate.thresholds)
    ) {
      issues.push({
        field: "thresholds",
        message: "thresholds must be a non-null object",
      });
    } else {
      const marketChallenge = parseThresholdValue(
        candidate.thresholds.marketChallenge,
        "thresholds.marketChallenge",
        issues,
      );
      if (marketChallenge !== undefined) {
        thresholds.marketChallenge = marketChallenge;
      }

      const squadDeposit = parseThresholdValue(
        candidate.thresholds.squadDeposit,
        "thresholds.squadDeposit",
        issues,
      );
      if (squadDeposit !== undefined) {
        thresholds.squadDeposit = squadDeposit;
      }
    }
  }

  if (issues.length > 0) {
    throw new FilterConfigValidationError(issues);
  }

  return Object.freeze({
    version,
    rules: Object.freeze(rules),
    thresholds: Object.freeze(thresholds),
  });
}

/**
 * Evaluates a {@link DecodedEvent} against a {@link CompiledFilterSet}.
 *
 * An event passes if:
 * 1. It satisfies all configured {@link AmountThresholds} (`meetsThreshold`), AND
 * 2. Either `rules` is empty (no expression filter active) or at least one
 *    compiled {@link FilterRule} matches the event.
 */
export function evaluateFilterSet(
  filterSet: CompiledFilterSet,
  event: DecodedEvent,
): boolean {
  if (!meetsThreshold(event, filterSet.thresholds)) {
    return false;
  }

  if (filterSet.rules.length === 0) {
    return true;
  }

  return filterSet.rules.some((rule) => evaluateFilterRule(rule, event));
}

/**
 * Holds the active {@link CompiledFilterSet} and performs atomic reloads.
 *
 * Each reload compiles and validates the entire candidate configuration first.
 * Only when full validation succeeds does the active reference swap to the new
 * immutable filter set. If validation fails, the previous working filter set
 * remains active and unchanged.
 */
export class AtomicFilterReloader {
  private current: CompiledFilterSet;

  /**
   * Creates a new reloader. If `initial` is provided, it is validated
   * immediately (throwing {@link FilterConfigValidationError} on failure).
   * Otherwise starts with an empty filter set at version 0.
   */
  constructor(initial?: FilterConfigCandidate) {
    this.current = initial ? compileFilterConfig(initial, 1) : compileFilterConfig({}, 0);
  }

  /** Returns the currently active immutable filter set snapshot. */
  public getCurrent(): CompiledFilterSet {
    return this.current;
  }

  /**
   * Atomically validates and swaps to `candidate`.
   *
   * Never throws on validation errors; instead returns `{ ok: false, applied: false, error, filterSet }`
   * while retaining the previous working filter set.
   */
  public reload(candidate: FilterConfigCandidate): FilterReloadResult {
    const previousVersion = this.current.version;
    try {
      const next = compileFilterConfig(candidate, previousVersion + 1);
      // Single atomic reference swap after full validation succeeds
      this.current = next;
      return {
        ok: true,
        applied: true,
        version: next.version,
        previousVersion,
        filterSet: next,
      };
    } catch (err) {
      const validationError =
        err instanceof FilterConfigValidationError
          ? err
          : new FilterConfigValidationError([
              {
                field: "candidate",
                message: err instanceof Error ? err.message : String(err),
                cause: err,
              },
            ]);
      return {
        ok: false,
        applied: false,
        version: this.current.version,
        error: validationError,
        filterSet: this.current,
      };
    }
  }

  /**
   * Atomically validates and swaps to `candidate`, throwing
   * {@link FilterConfigValidationError} if validation fails.
   * The previous working filter set is retained on failure.
   */
  public reloadOrThrow(candidate: FilterConfigCandidate): CompiledFilterSet {
    const result = this.reload(candidate);
    if (!result.ok) {
      throw result.error;
    }
    return result.filterSet;
  }

  /** Evaluates an event against the currently active filter set snapshot. */
  public matches(event: DecodedEvent): boolean {
    return evaluateFilterSet(this.current, event);
  }
}
