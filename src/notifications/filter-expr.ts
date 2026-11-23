/**
 * Filter expression parser and evaluator for events.
 *
 * Syntax:
 *   [<eventName>] [where <condition>]
 *   - Both parts or either part can be specified. If eventName is omitted, matches any event.
 *   - Conditions support comparison operators: ==, !=, =, <, <=, >, >=
 *   - Logical operators: and, or (case-insensitive), with grouping parentheses ( )
 *   - Operands: field identifiers, integer numbers, float numbers, string literals ('...' or "..."),
 *     USDC amounts with optional USDC suffix (e.g. 100 USDC or $100 or 100), and booleans (true, false).
 *   - Pure evaluation over DecodedEvent without eval or dynamic code execution.
 *   - Static field validation and type compatibility checking against known payload types.
 *   - Bounded token count (max 100 tokens) and nesting depth (max 10) to guard against
 *     hostile allocation spikes or recursion depth exhaustion before and during parsing.
 *   - Dry-run diagnostics that report a missing payload field separately from a false
 *     predicate (`evaluateFilterRuleDiagnostic`, `evaluateFilterDryRun`), while
 *     `evaluateFilterRule` keeps its existing boolean allow-or-deny contract.
 */

import { createHash } from "node:crypto";

import type { DecodedEvent } from "../stellar/decode.js";
import {
  evaluateThresholdDiagnostic,
  InvalidThresholdError,
  parseUsdcThreshold,
  type AmountThresholds,
  type ThresholdDiagnostic,
} from "./amount-threshold.js";

/** USDC atomic unit divisor (7 decimal places). */
export const USDC_SCALE = 10_000_000n;

/**
 * Current normalized schema version for notification filter compilation.
 * Bumped when the schema structure or normalization rules change incompatibly.
 */
export const FILTER_SCHEMA_VERSION = 1;

/**
 * Expected schema type for fields.
 */
export type FieldType = "string" | "number" | "bigint" | "boolean";

export interface FieldDefinition {
  type: FieldType;
  /** Whether the field is an amount in atomic 7-decimal USDC units. */
  isUsdcAmount?: boolean;
}

export interface NormalizedFieldDefinition {
  isUsdcAmount: boolean;
  type: FieldType;
}

export type NormalizedEventSchema = Record<string, NormalizedFieldDefinition>;
export type NormalizedSchemaRegistry = Record<string, NormalizedEventSchema>;

/**
 * Known fields and types for each event payload name.
 */
export const EVENT_PAYLOAD_SCHEMAS: Record<string, Record<string, FieldDefinition>> = {
  claim_created: {
    name: { type: "string" },
    claimId: { type: "number" },
    creator: { type: "string" },
    category: { type: "string" },
    title: { type: "string" },
  },
  claim_challenged: {
    name: { type: "string" },
    claimId: { type: "number" },
    challenger: { type: "string" },
    stake: { type: "bigint", isUsdcAmount: true },
  },
  claim_resolved: {
    name: { type: "string" },
    claimId: { type: "number" },
    winnerSide: { type: "number" },
    summary: { type: "string" },
    confidence: { type: "number" },
    evidenceHash: { type: "string" },
    resolver: { type: "string" },
  },
  claim_cancelled: {
    name: { type: "string" },
    claimId: { type: "number" },
  },
  market_settled: {
    name: { type: "string" },
    claimId: { type: "number" },
    totalPaid: { type: "bigint", isUsdcAmount: true },
    totalFees: { type: "bigint", isUsdcAmount: true },
    owedToChallengers: { type: "bigint", isUsdcAmount: true },
    dust: { type: "bigint", isUsdcAmount: true },
  },
  challenger_paid: {
    name: { type: "string" },
    claimId: { type: "number" },
    challenger: { type: "string" },
    stake: { type: "bigint", isUsdcAmount: true },
    gross: { type: "bigint", isUsdcAmount: true },
    fee: { type: "bigint", isUsdcAmount: true },
    net: { type: "bigint", isUsdcAmount: true },
  },
  fee_claimed: {
    name: { type: "string" },
    recipient: { type: "string" },
    amount: { type: "bigint", isUsdcAmount: true },
  },
  withdrawal: {
    name: { type: "string" },
    to: { type: "string" },
    amount: { type: "bigint", isUsdcAmount: true },
  },
  withdrawal_pending: {
    name: { type: "string" },
    to: { type: "string" },
    amount: { type: "bigint", isUsdcAmount: true },
  },
  market_created: {
    name: { type: "string" },
    marketId: { type: "number" },
    captain: { type: "string" },
    deadline: { type: "number" },
    feeBps: { type: "number" },
    question: { type: "string" },
    category: { type: "string" },
  },
  deposited: {
    name: { type: "string" },
    marketId: { type: "number" },
    side: { type: "number" },
    participant: { type: "string" },
    amount: { type: "bigint", isUsdcAmount: true },
    shares: { type: "bigint" },
  },
  withdrawn: {
    name: { type: "string" },
    marketId: { type: "number" },
    side: { type: "number" },
    participant: { type: "string" },
    amount: { type: "bigint", isUsdcAmount: true },
  },
  resolved: {
    name: { type: "string" },
    marketId: { type: "number" },
    result: { type: "number" },
    poolA: { type: "bigint", isUsdcAmount: true },
    poolB: { type: "bigint", isUsdcAmount: true },
  },
  claimed: {
    name: { type: "string" },
    marketId: { type: "number" },
    participant: { type: "string" },
    gross: { type: "bigint", isUsdcAmount: true },
    fee: { type: "bigint", isUsdcAmount: true },
    net: { type: "bigint", isUsdcAmount: true },
  },
  fees_claimed: {
    name: { type: "string" },
    recipient: { type: "string" },
    amount: { type: "bigint", isUsdcAmount: true },
  },
  oracle_changed: {
    name: { type: "string" },
    newOracle: { type: "string" },
    admin: { type: "string" },
  },
  ownership_transferred: {
    name: { type: "string" },
    previousOwner: { type: "string" },
    newOwner: { type: "string" },
    admin: { type: "string" },
  },
  agent_attributed: {
    name: { type: "string" },
    agent: { type: "string" },
    admin: { type: "string" },
  },
  fee_accrued: {
    name: { type: "string" },
    recipient: { type: "string" },
    amount: { type: "bigint", isUsdcAmount: true },
    admin: { type: "string" },
  },
};

// ----------------------------------------------------
// Schema Normalization and Fingerprinting
// ----------------------------------------------------

/**
 * Normalizes a schema version input into a positive integer.
 * Accepts positive numbers or strings (e.g. "1", "v1", "v1.0").
 */
export function normalizeSchemaVersion(version: number | string = FILTER_SCHEMA_VERSION): number {
  if (typeof version === "number") {
    if (!Number.isFinite(version) || version <= 0) {
      throw new Error(`Invalid schema version: ${version}`);
    }
    return Math.floor(version);
  }
  if (typeof version === "string") {
    const cleaned = version.trim().replace(/^[vV]/, "");
    const parsed = parseInt(cleaned, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`Invalid schema version string: "${version}"`);
    }
    return parsed;
  }
  throw new Error(`Schema version must be a number or string, got ${typeof version}`);
}

/**
 * Normalizes a single field definition to canonical form.
 */
export function normalizeFieldDefinition(def: FieldDefinition): NormalizedFieldDefinition {
  return {
    isUsdcAmount: Boolean(def.isUsdcAmount),
    type: def.type,
  };
}

/**
 * Normalizes an event payload schema by sorting field names and canonicalizing definitions.
 */
export function normalizeEventSchema(
  schema: Record<string, FieldDefinition>,
): NormalizedEventSchema {
  const sortedKeys = Object.keys(schema).sort();
  const normalized: NormalizedEventSchema = {};
  for (const key of sortedKeys) {
    const field = schema[key];
    if (field) {
      normalized[key] = normalizeFieldDefinition(field);
    }
  }
  return normalized;
}

/**
 * Normalizes a full event schema registry by sorting event names and fields.
 */
export function normalizeSchemaRegistry(
  schemas: Record<string, Record<string, FieldDefinition>>,
): NormalizedSchemaRegistry {
  const sortedEvents = Object.keys(schemas).sort();
  const normalized: NormalizedSchemaRegistry = {};
  for (const eventName of sortedEvents) {
    const eventSchema = schemas[eventName];
    if (eventSchema) {
      normalized[eventName] = normalizeEventSchema(eventSchema);
    }
  }
  return normalized;
}

/**
 * Canonicalizes a schema (either a single event schema or a full registry)
 * into a normalized structure.
 */
export function normalizeSchema(
  schema: Record<string, FieldDefinition> | Record<string, Record<string, FieldDefinition>>,
): NormalizedEventSchema | NormalizedSchemaRegistry {
  const entries = Object.entries(schema);
  if (entries.length === 0) {
    return {};
  }
  const firstVal = entries[0]?.[1];
  if (firstVal && typeof firstVal === "object" && "type" in firstVal) {
    return normalizeEventSchema(schema as Record<string, FieldDefinition>);
  }
  return normalizeSchemaRegistry(schema as Record<string, Record<string, FieldDefinition>>);
}

/**
 * Deterministically serializes a schema and its version to a JSON string.
 */
export function canonicalizeSchema(
  schema: Record<string, FieldDefinition> | Record<string, Record<string, FieldDefinition>>,
  version: number = FILTER_SCHEMA_VERSION,
): string {
  const normalizedVersion = normalizeSchemaVersion(version);
  const normalized = normalizeSchema(schema);
  return JSON.stringify({
    schema: normalized,
    version: normalizedVersion,
  });
}

/**
 * Computes a SHA-256 hex digest of a normalized schema and its version.
 */
export function computeSchemaDigest(
  schema: Record<string, FieldDefinition> | Record<string, Record<string, FieldDefinition>>,
  version: number = FILTER_SCHEMA_VERSION,
): string {
  const canonical = canonicalizeSchema(schema, version);
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Computes the normalized schema digest for a specific event within a registry.
 */
export function getEventSchemaDigest(
  eventName: string,
  schemas: Record<string, Record<string, FieldDefinition>> = EVENT_PAYLOAD_SCHEMAS,
  version: number = FILTER_SCHEMA_VERSION,
): string {
  const eventSchema = schemas[eventName];
  if (!eventSchema) {
    throw new Error(`Unknown event schema "${eventName}"`);
  }
  const normalizedVersion = normalizeSchemaVersion(version);
  const normalized = normalizeEventSchema(eventSchema);
  const canonical = JSON.stringify({
    eventName,
    schema: normalized,
    version: normalizedVersion,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Computes the normalized schema digest for the entire schema registry.
 */
export function getSchemaDigest(
  schemas: Record<string, Record<string, FieldDefinition>> = EVENT_PAYLOAD_SCHEMAS,
  version: number = FILTER_SCHEMA_VERSION,
): string {
  return computeSchemaDigest(schemas, version);
}

/** Parse / Validation Error with character position. */
export class FilterParseError extends Error {
  public readonly position: number;
  public readonly range: SourceRange;
  public readonly code: FilterErrorCode;

  constructor(
    message: string,
    position: number,
    end?: number,
    code: FilterErrorCode = "FILTER_SYNTAX_ERROR",
  ) {
    super(`At character ${position}: ${message}`);
    this.name = "FilterParseError";
    this.position = position;
    this.range = { start: position, end: end !== undefined && end >= position ? end : position };
    this.code = code;
  }
}

/** Supported comparison operators. */
export type ComparisonOp = "==" | "!=" | "<" | "<=" | ">" | ">=";

/** Value literals supported by the AST. */
export type LiteralValue =
  | { kind: "string"; value: string }
  | { kind: "number"; value: number; raw?: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "usdc"; atomic: bigint; rawDecimal: string };

export type ExprNode =
  | { type: "logical"; op: "and" | "or"; left: ExprNode; right: ExprNode }
  | {
      type: "comparison";
      op: ComparisonOp;
      opPos: number;
      opEnd: number;
      field: string;
      fieldPos: number;
      fieldEnd: number;
      value: LiteralValue;
      valuePos: number;
      valueEnd: number;
    };

export interface FilterRule {
  eventName?: string;
  eventNamePos?: number;
  eventNameEnd?: number;
  condition?: ExprNode;
  rawExpression: string;
  /** Schema version at compilation time. */
  schemaVersion?: number;
  /** SHA-256 fingerprint digest of the normalized schema. */
  digest?: string;
  /** Alias to digest. */
  schemaDigest?: string;
  /** Alias to digest. */
  fingerprint?: string;
  /** Event-specific schema digest if eventName is present. */
  eventDigest?: string;
  /** Registry-wide schema digest. */
  registryDigest?: string;
}

/**
 * A compiled, versioned, and fingerprinted notification filter rule.
 */
export interface CompiledFilterRule extends FilterRule {
  schemaVersion: number;
  digest: string;
  schemaDigest: string;
  fingerprint: string;
  evaluate: (event: DecodedEvent) => boolean;
  isStale: (
    schemas?: Record<string, Record<string, FieldDefinition>>,
    currentVersion?: number | string,
  ) => boolean;
}

export interface CompileFilterOptions {
  /** Target schema version to compile against. Defaults to FILTER_SCHEMA_VERSION (1). */
  schemaVersion?: number | string;
  /** Schema registry to validate against and fingerprint. Defaults to EVENT_PAYLOAD_SCHEMAS. */
  schemas?: Record<string, Record<string, FieldDefinition>>;
}

// ----------------------------------------------------
// Lexer / Tokenizer
// ----------------------------------------------------

export type TokenType =
  | "IDENTIFIER"
  | "STRING"
  | "NUMBER"
  | "USDC"
  | "OP"
  | "AND"
  | "OR"
  | "WHERE"
  | "LPAREN"
  | "RPAREN"
  | "EOF";

export interface Token {
  type: TokenType;
  text: string;
  pos: number;
  end: number;
  value?: unknown;
}

class Lexer {
  private input: string;
  private pos = 0;

  constructor(input: string) {
    this.input = input;
  }

  public nextToken(): Token {
    this.skipWhitespace();

    if (this.pos >= this.input.length) {
      return { type: "EOF", text: "", pos: this.pos, end: this.pos };
    }

    const start = this.pos;
    const ch = this.input[this.pos];
    if (ch === undefined) {
      return { type: "EOF", text: "", pos: this.pos, end: this.pos };
    }

    if (ch === "(") {
      this.pos++;
      return { type: "LPAREN", text: "(", pos: start, end: this.pos };
    }
    if (ch === ")") {
      this.pos++;
      return { type: "RPAREN", text: ")", pos: start, end: this.pos };
    }

    // Comparison operators
    if (ch === "=") {
      this.pos++;
      if (this.pos < this.input.length && this.input[this.pos] === "=") {
        this.pos++;
        return { type: "OP", text: "==", pos: start, end: this.pos };
      }
      return { type: "OP", text: "==", pos: start, end: this.pos }; // normalize '=' to '=='
    }
    if (ch === "!" && this.pos + 1 < this.input.length && this.input[this.pos + 1] === "=") {
      this.pos += 2;
      return { type: "OP", text: "!=", pos: start, end: this.pos };
    }
    if (ch === "<") {
      this.pos++;
      if (this.pos < this.input.length && this.input[this.pos] === "=") {
        this.pos++;
        return { type: "OP", text: "<=", pos: start, end: this.pos };
      }
      return { type: "OP", text: "<", pos: start, end: this.pos };
    }
    if (ch === ">") {
      this.pos++;
      if (this.pos < this.input.length && this.input[this.pos] === "=") {
        this.pos++;
        return { type: "OP", text: ">=", pos: start, end: this.pos };
      }
      return { type: "OP", text: ">", pos: start, end: this.pos };
    }

    // Quoted strings: '...' or "..."
    if (ch === "'" || ch === '"') {
      const quote = ch;
      this.pos++;
      let str = "";
      while (this.pos < this.input.length) {
        const c = this.input[this.pos];
        if (c === "\\") {
          const escStart = this.pos;
          this.pos++;
          if (this.pos >= this.input.length) {
            throw new FilterParseError("Unterminated string escape", escStart, this.pos);
          }
          str += this.input[this.pos] ?? "";
          this.pos++;
        } else if (c === quote) {
          this.pos++;
          return { type: "STRING", text: str, pos: start, end: this.pos, value: str };
        } else {
          str += c;
          this.pos++;
        }
      }
      throw new FilterParseError(`Unterminated string starting with ${quote}`, start, start + 1);
    }

    // Dollar-prefixed USDC literal: e.g. $100, $5.50
    if (ch === "$") {
      this.pos++;
      const numStr = this.readNumberString();
      if (!numStr) {
        throw new FilterParseError("Expected number after '$'", start, start + 1);
      }
      return {
        type: "USDC",
        text: "$" + numStr,
        pos: start,
        end: this.pos,
        value: parseUsdcStringToUnits(numStr, start, this.pos),
      };
    }

    // Number (digits, optional dot and decimal digits)
    if (this.isDigit(ch)) {
      const numStr = this.readNumberString();
      // Check if immediately followed by optional whitespace and 'USDC'
      const savedPos = this.pos;
      this.skipWhitespace();
      const lookaheadWord = this.readWord();
      if (lookaheadWord && lookaheadWord.toUpperCase() === "USDC") {
        return {
          type: "USDC",
          text: numStr + " USDC",
          pos: start,
          end: this.pos,
          value: parseUsdcStringToUnits(numStr, start, this.pos),
        };
      }
      // Revert if not USDC
      this.pos = savedPos;
      return {
        type: "NUMBER",
        text: numStr,
        pos: start,
        end: this.pos,
        value: numStr.includes(".") ? parseFloat(numStr) : parseInt(numStr, 10),
      };
    }

    // Word: identifier or keyword
    if (this.isIdentStart(ch)) {
      const word = this.readWord();
      const lower = word.toLowerCase();
      if (lower === "where") {
        return { type: "WHERE", text: word, pos: start, end: this.pos };
      }
      if (lower === "and") {
        return { type: "AND", text: word, pos: start, end: this.pos };
      }
      if (lower === "or") {
        return { type: "OR", text: word, pos: start, end: this.pos };
      }
      return { type: "IDENTIFIER", text: word, pos: start, end: this.pos };
    }

    throw new FilterParseError(`Unexpected character '${ch}'`, start, start + 1);
  }

  private skipWhitespace() {
    while (this.pos < this.input.length) {
      const c = this.input[this.pos];
      if (c && /\s/.test(c)) {
        this.pos++;
      } else {
        break;
      }
    }
  }

  private isDigit(ch: string): boolean {
    return ch >= "0" && ch <= "9";
  }

  private isIdentStart(ch: string): boolean {
    return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
  }

  private isIdentPart(ch: string): boolean {
    return this.isIdentStart(ch) || this.isDigit(ch) || ch === "-";
  }

  private readWord(): string {
    const start = this.pos;
    while (this.pos < this.input.length) {
      const c = this.input[this.pos];
      if (c && this.isIdentPart(c)) {
        this.pos++;
      } else {
        break;
      }
    }
    return this.input.slice(start, this.pos);
  }

  private readNumberString(): string {
    const start = this.pos;
    while (this.pos < this.input.length) {
      const c = this.input[this.pos];
      if (c && this.isDigit(c)) {
        this.pos++;
      } else {
        break;
      }
    }
    const dotChar = this.input[this.pos];
    const nextChar = this.pos + 1 < this.input.length ? this.input[this.pos + 1] : undefined;
    if (dotChar === "." && nextChar && this.isDigit(nextChar)) {
      this.pos++; // dot
      while (this.pos < this.input.length) {
        const c = this.input[this.pos];
        if (c && this.isDigit(c)) {
          this.pos++;
        } else {
          break;
        }
      }
    }
    return this.input.slice(start, this.pos);
  }
}

/** Convert a decimal string to 7-decimal atomic bigint. */
export function parseUsdcStringToUnits(numStr: string, pos = 0): bigint {
  const trimmed = numStr.trim();
  const parts = trimmed.split(".");
  if (parts.length === 2 && (parts[1]?.length ?? 0) > 7) {
    throw new FilterParseError(
      `USDC amount "${trimmed}" exceeds maximum precision of 7 decimals`,
      pos,
      end ?? pos + numStr.length,
      "FILTER_USDC_PRECISION",
    );
  }

  try {
    return parseUsdcThreshold(trimmed);
  } catch (err) {
    if (err instanceof InvalidThresholdError) {
      throw new FilterParseError(err.message, pos);
    }
    throw err;
  }
}

/**
 * Options for configuring filter expression parsing.
 */
export interface FilterParserOptions {
  /**
   * Maximum allowed non-EOF tokens in the expression.
   * Defaults to {@link MAX_FILTER_TOKENS} (100).
   */
  maxTokens?: number;
  /**
   * Maximum allowed nesting depth for parentheses.
   * Defaults to {@link MAX_FILTER_DEPTH} (10).
   */
  maxDepth?: number;
}

/**
 * Counts the tokens in a filter expression by running a streaming lexer pass
 * without allocating an AST or holding an array of tokens.
 *
 * @throws {@link FilterTokenLimitError} if token count exceeds maxTokens.
 * @throws {@link FilterParseError} on lexical syntax errors.
 */
export function countFilterTokens(input: string, maxTokens: number = MAX_FILTER_TOKENS): number {
  const lexer = new Lexer(input);
  let count = 0;
  while (true) {
    const token = lexer.nextToken();
    if (token.type === "EOF") {
      break;
    }
    count++;
    if (count > maxTokens) {
      throw new FilterTokenLimitError(count, maxTokens, { start: token.pos, end: token.end });
    }
  }
  return count;
}

// ----------------------------------------------------
// Parser
// ----------------------------------------------------

export class FilterParser {
  private lexer: Lexer;
  private currentToken: Token;
  private schemas: Record<string, Record<string, FieldDefinition>>;

  constructor(
    input: string,
    schemas: Record<string, Record<string, FieldDefinition>> = EVENT_PAYLOAD_SCHEMAS,
  ) {
    this.lexer = new Lexer(input);
    this.currentToken = this.lexer.nextToken();
    this.schemas = schemas;
  }

  private advance(): Token {
    this.currentToken = this.lexer.nextToken();
    if (this.currentToken.type !== "EOF") {
      this.tokenCount++;
      if (this.tokenCount > this.maxTokens) {
        throw new FilterTokenLimitError(this.tokenCount, this.maxTokens, {
          start: this.currentToken.pos,
          end: this.currentToken.end,
        });
      }
    }
    return this.currentToken;
  }

  public parseRule(rawExpression: string): FilterRule {
    let eventName: string | undefined;
    let eventNamePos: number | undefined;
    let eventNameEnd: number | undefined;

    // Check if expression starts with an event name (identifier not equal to 'where')
    if (this.currentToken.type === "IDENTIFIER") {
      eventName = this.currentToken.text;
      eventNamePos = this.currentToken.pos;
      eventNameEnd = this.currentToken.end;
      this.advance();

      // Check if event name is known if schemas are defined
      if (this.schemas && !(eventName in this.schemas)) {
        throw new FilterParseError(`Unknown event name "${eventName}"`, eventNamePos);
      }
    }

    let condition: ExprNode | undefined;

    if (this.currentToken.type === "WHERE") {
      this.advance();
      condition = this.parseExpression();
    } else if (this.currentToken.type !== "EOF") {
      if (!eventName) {
        throw new FilterParseError(
          `Unexpected token "${boundedTokenLabel(this.currentToken.text)}". Expected event name or 'where'`,
          this.currentToken.pos,
          this.currentToken.end,
        );
      } else {
        throw new FilterParseError(
          `Expected 'where' or end of expression, got "${boundedTokenLabel(this.currentToken.text)}"`,
          this.currentToken.pos,
          this.currentToken.end,
        );
      }
    }

    if (this.currentToken.type !== "EOF") {
      throw new FilterParseError(
        `Unexpected extra input "${boundedTokenLabel(this.currentToken.text)}"`,
        this.currentToken.pos,
        this.currentToken.end,
      );
    }

    // Validate fields against schema if eventName is specified
    if (condition && eventName) {
      validateConditionAgainstSchema(condition, eventName, this.schemas);
    }

    return {
      eventName,
      eventNamePos,
      eventNameEnd,
      condition,
      rawExpression,
    };
  }

  private parseExpression(): ExprNode {
    return this.parseOr();
  }

  private parseOr(): ExprNode {
    let left = this.parseAnd();

    while (this.currentToken.type === "OR") {
      this.advance();
      const right = this.parseAnd();
      left = { type: "logical", op: "or", left, right };
    }

    return left;
  }

  private parseAnd(): ExprNode {
    let left = this.parsePrimary();

    while (this.currentToken.type === "AND") {
      this.advance();
      const right = this.parsePrimary();
      left = { type: "logical", op: "and", left, right };
    }

    return left;
  }

  private parsePrimary(): ExprNode {
    if (this.currentToken.type === "LPAREN") {
      const parenPos = this.currentToken.pos;
      this.currentDepth++;
      if (this.currentDepth > this.maxDepth) {
        throw new FilterDepthLimitError(this.currentDepth, this.maxDepth, parenPos);
      }
      this.advance();
      const expr = this.parseExpression();
      if ((this.currentToken.type as TokenType) !== "RPAREN") {
        throw new FilterParseError(
          "Expected closing ')'",
          this.currentToken.pos,
          this.currentToken.end,
        );
      }
      this.currentDepth--;
      this.advance();
      return expr;
    }

    return this.parseComparison();
  }

  private parseComparison(): ExprNode {
    if ((this.currentToken.type as TokenType) !== "IDENTIFIER") {
      throw new FilterParseError(
        `Expected field name, found "${boundedTokenLabel(this.currentToken.text || "EOF")}"`,
        this.currentToken.pos,
        this.currentToken.end,
      );
    }

    const field = this.currentToken.text;
    const fieldPos = this.currentToken.pos;
    const fieldEnd = this.currentToken.end;
    this.advance();

    if ((this.currentToken.type as TokenType) !== "OP") {
      throw new FilterParseError(
        `Expected comparison operator (==, !=, <, <=, >, >=), found "${boundedTokenLabel(this.currentToken.text || "EOF")}"`,
        this.currentToken.pos,
        this.currentToken.end,
      );
    }

    const op = this.currentToken.text as ComparisonOp;
    const opPos = this.currentToken.pos;
    const opEnd = this.currentToken.end;
    this.advance();

    const valuePos = this.currentToken.pos;
    const valueEnd = this.currentToken.end;
    const value = this.parseLiteral();

    return {
      type: "comparison",
      op,
      opPos,
      opEnd,
      field,
      fieldPos,
      fieldEnd,
      value,
      valuePos,
      valueEnd,
    };
  }

  private parseLiteral(): LiteralValue {
    const tok = this.currentToken;

    if (tok.type === "STRING") {
      this.advance();
      return { kind: "string", value: tok.value as string };
    }

    if (tok.type === "USDC") {
      this.advance();
      return { kind: "usdc", atomic: tok.value as bigint, rawDecimal: tok.text };
    }

    if (tok.type === "NUMBER") {
      this.advance();
      return { kind: "number", value: tok.value as number, raw: tok.text };
    }

    if (tok.type === "IDENTIFIER") {
      const lower = tok.text.toLowerCase();
      if (lower === "true" || lower === "false") {
        this.advance();
        return { kind: "boolean", value: lower === "true" };
      }
    }

    throw new FilterParseError(
      `Expected literal value (string, number, USDC amount, or boolean), got "${boundedTokenLabel(tok.text || "EOF")}"`,
      tok.pos,
      tok.end,
    );
  }
}

/** Validate fields and types in condition against the given event payload schema. */
export function validateConditionAgainstSchema(
  condition: ExprNode,
  eventName: string,
  schemas: Record<string, Record<string, FieldDefinition>> = EVENT_PAYLOAD_SCHEMAS,
): void {
  const schema = schemas[eventName];
  if (!schema) return;
  const currentSchema = schema;

    case "boolean":
      if (node.value.kind !== "boolean") {
        throw new FilterParseError(
          `Field "${node.field}" is a boolean, but got ${node.value.kind} literal`,
          node.valuePos,
        );
      }
      if (node.op !== "==" && node.op !== "!=") {
        throw new FilterParseError(
          `Operator "${node.op}" cannot be used on boolean field "${node.field}"`,
          node.fieldPos,
        );
      }
      break;

    const fieldDef = currentSchema[node.field];
    if (!fieldDef) {
      throw new FilterParseError(
        `Unknown field "${boundedTokenLabel(node.field)}" for event "${eventName}"`,
        node.fieldPos,
        node.fieldEnd,
        "FILTER_UNKNOWN_FIELD",
      );
    }

    // Check type compatibility
    switch (fieldDef.type) {
      case "string":
        if (node.value.kind !== "string") {
          throw new FilterParseError(
            `Field "${node.field}" is a string, but got ${node.value.kind} literal`,
            node.valuePos,
            node.valueEnd,
            "FILTER_TYPE_MISMATCH",
          );
        }
        if (node.op !== "==" && node.op !== "!=") {
          throw new FilterParseError(
            `Operator "${node.op}" cannot be used on string field "${node.field}" (only == and != are supported)`,
            node.opPos,
            node.opEnd,
            "FILTER_OPERATOR_NOT_SUPPORTED",
          );
        }
        break;

      case "boolean":
        if (node.value.kind !== "boolean") {
          throw new FilterParseError(
            `Field "${node.field}" is a boolean, but got ${node.value.kind} literal`,
            node.valuePos,
            node.valueEnd,
            "FILTER_TYPE_MISMATCH",
          );
        }
        if (node.op !== "==" && node.op !== "!=") {
          throw new FilterParseError(
            `Operator "${node.op}" cannot be used on boolean field "${node.field}"`,
            node.opPos,
            node.opEnd,
            "FILTER_OPERATOR_NOT_SUPPORTED",
          );
        }
        break;

      case "bigint":
        // Bigint fields (like stake, amount) can be compared to usdc literals or numbers
        if (node.value.kind !== "usdc" && node.value.kind !== "number") {
          throw new FilterParseError(
            `Field "${node.field}" is a USDC amount, but got ${node.value.kind} literal`,
            node.valuePos,
          );
        }
      } else {
        if (node.value.kind === "usdc") {
          throw new FilterParseError(
            `Mixed-unit comparison: field "${node.field}" is not a USDC amount, cannot compare with usdc literal`,
            node.valuePos,
          );
        }
        if (node.value.kind !== "number") {
          throw new FilterParseError(
            `Field "${node.field}" is an integer, but got ${node.value.kind} literal`,
            node.valuePos,
            node.valueEnd,
            "FILTER_TYPE_MISMATCH",
          );
        }
        if (node.value.kind === "number") {
          const raw = node.value.raw ?? String(node.value.value);
          parseUsdcStringToUnits(raw, node.valuePos);
        }
        break;

      case "number":
        if (node.value.kind !== "number") {
          throw new FilterParseError(
            `Field "${node.field}" is an integer, cannot compare with fractional number ${node.value.value}`,
            node.valuePos,
            node.valueEnd,
            "FILTER_TYPE_MISMATCH",
          );
        }
      }
      break;

    case "number":
      if (node.value.kind === "usdc") {
        throw new FilterParseError(
          `Mixed-unit comparison: field "${node.field}" is a number (not a USDC amount), cannot compare with usdc literal`,
          node.valuePos,
        );
      }
      if (node.value.kind !== "number") {
        throw new FilterParseError(
          `Field "${node.field}" is a number, but got ${node.value.kind} literal`,
          node.valuePos,
        );
      }
      break;
  }
}

/**
 * Validate fields, types, and unit compatibility in condition against the event
 * payload schema (or global known fields when eventName is omitted).
 */
export function validateConditionAgainstSchema(condition: ExprNode, eventName?: string): void {
  const schema = eventName ? EVENT_PAYLOAD_SCHEMAS[eventName] : undefined;
  if (eventName && !schema) return;

  function traverse(node: ExprNode): void {
    if (node.type === "logical") {
      traverse(node.left);
      traverse(node.right);
      return;
    }

    if (schema) {
      const fieldDef = schema[node.field];
      if (!fieldDef) {
        throw new FilterParseError(
          `Unknown field "${node.field}" for event "${eventName}"`,
          node.fieldPos,
        );
      }
      validateComparisonField(node, fieldDef);
      return;
    }

    // Event-less rule: validate any known schema/metadata field to catch mixed-unit comparisons early.
    const knownFieldDef = GLOBAL_FIELD_SCHEMAS[node.field];
    if (knownFieldDef) {
      validateComparisonField(node, knownFieldDef);
    }
  }

  traverse(condition);
}

// ----------------------------------------------------
// Compilation & Staleness Detection
// ----------------------------------------------------

/**
 * Compiles a parsed {@link FilterRule} by attaching normalized schema version
 * and SHA-256 fingerprint digest metadata, along with evaluate and staleness check helpers.
 *
 * @param rule The parsed filter rule.
 * @param options Compilation options (target schema version and schemas registry).
 * @returns A {@link CompiledFilterRule} carrying version, digest, and helper methods.
 */
export function compileFilterRule(
  rule: FilterRule,
  options: CompileFilterOptions = {},
): CompiledFilterRule {
  const schemas = options.schemas ?? EVENT_PAYLOAD_SCHEMAS;
  const version = normalizeSchemaVersion(options.schemaVersion ?? FILTER_SCHEMA_VERSION);

  // Validate eventName if provided
  if (rule.eventName && !(rule.eventName in schemas)) {
    throw new FilterParseError(
      `Unknown event name "${rule.eventName}"`,
      rule.eventNamePos ?? 0,
    );
  }

  // Validate condition against schema if eventName is specified
  if (rule.condition && rule.eventName) {
    validateConditionAgainstSchema(rule.condition, rule.eventName, schemas);
  }

  // Compute digests
  const registryDigest = getSchemaDigest(schemas, version);
  let eventDigest: string | undefined;
  let primaryDigest: string;

  if (rule.eventName) {
    eventDigest = getEventSchemaDigest(rule.eventName, schemas, version);
    primaryDigest = eventDigest;
  } else {
    primaryDigest = registryDigest;
  }

  const compiled: CompiledFilterRule = {
    ...rule,
    schemaVersion: version,
    digest: primaryDigest,
    schemaDigest: primaryDigest,
    fingerprint: primaryDigest,
    eventDigest,
    registryDigest,
    evaluate: (event: DecodedEvent) => evaluateFilterRule(compiled, event),
    isStale: (
      currentSchemas = EVENT_PAYLOAD_SCHEMAS,
      currentVersion = FILTER_SCHEMA_VERSION,
    ) => isFilterRuleStale(compiled, currentSchemas, currentVersion),
  };

  return compiled;
}

/**
 * Parses and compiles a filter expression string into a {@link CompiledFilterRule}
 * with attached schema version and digest.
 *
 * @throws {@link FilterParseError} on invalid syntax, unknown fields, or type mismatches.
 */
export function compileFilterExpression(
  input: string,
  options: CompileFilterOptions = {},
): CompiledFilterRule {
  const schemas = options.schemas ?? EVENT_PAYLOAD_SCHEMAS;
  const parser = new FilterParser(input.trim(), schemas);
  const parsed = parser.parseRule(input);
  return compileFilterRule(parsed, options);
}

/**
 * Convenience function to compile either a raw expression string or an existing {@link FilterRule}.
 */
export function compileFilter(
  inputOrRule: string | FilterRule,
  options: CompileFilterOptions = {},
): CompiledFilterRule {
  if (typeof inputOrRule === "string") {
    return compileFilterExpression(inputOrRule, options);
  }
  return compileFilterRule(inputOrRule, options);
}

/**
 * Result of a staleness check on a compiled filter rule.
 */
export interface StalenessCheckResult {
  stale: boolean;
  reason?:
    | "UNCOMPILED_RULE"
    | "VERSION_MISMATCH"
    | "UNKNOWN_EVENT"
    | "SCHEMA_DIGEST_MISMATCH"
    | "CONDITION_VALIDATION_FAILED";
  details?: string;
}

/**
 * Checks whether a compiled filter rule is stale relative to current event schemas
 * or a bumped schema version.
 */
export function checkFilterStaleness(
  rule: FilterRule,
  schemas: Record<string, Record<string, FieldDefinition>> = EVENT_PAYLOAD_SCHEMAS,
  currentVersion: number | string = FILTER_SCHEMA_VERSION,
): StalenessCheckResult {
  const expectedVersion = normalizeSchemaVersion(currentVersion);

  if (
    rule.schemaVersion === undefined ||
    (!rule.digest && !rule.schemaDigest && !rule.fingerprint)
  ) {
    return {
      stale: true,
      reason: "UNCOMPILED_RULE",
      details: "Rule does not carry schemaVersion and digest metadata",
    };
  }

  if (rule.schemaVersion !== expectedVersion) {
    return {
      stale: true,
      reason: "VERSION_MISMATCH",
      details: `Rule schema version ${rule.schemaVersion} does not match current version ${expectedVersion}`,
    };
  }

  const ruleDigest = rule.digest ?? rule.schemaDigest ?? rule.fingerprint;

  if (rule.eventName) {
    if (!(rule.eventName in schemas)) {
      return {
        stale: true,
        reason: "UNKNOWN_EVENT",
        details: `Event "${rule.eventName}" is no longer in current schemas`,
      };
    }

    const currentEventDigest = getEventSchemaDigest(rule.eventName, schemas, expectedVersion);
    const currentRegistryDigest = getSchemaDigest(schemas, expectedVersion);

    if (ruleDigest !== currentEventDigest && ruleDigest !== currentRegistryDigest) {
      return {
        stale: true,
        reason: "SCHEMA_DIGEST_MISMATCH",
        details: `Schema digest mismatch for event "${rule.eventName}"`,
      };
    }

    if (rule.condition) {
      try {
        validateConditionAgainstSchema(rule.condition, rule.eventName, schemas);
      } catch (err) {
        return {
          stale: true,
          reason: "CONDITION_VALIDATION_FAILED",
          details: (err as Error).message,
        };
      }
    }
  } else {
    const currentRegistryDigest = getSchemaDigest(schemas, expectedVersion);
    if (ruleDigest !== currentRegistryDigest) {
      return {
        stale: true,
        reason: "SCHEMA_DIGEST_MISMATCH",
        details: "Global schema registry digest mismatch",
      };
    }
  }

  return { stale: false };
}

/**
 * Returns true if a compiled filter rule has become stale due to schema changes or version bumps.
 */
export function isFilterRuleStale(
  rule: FilterRule,
  schemas: Record<string, Record<string, FieldDefinition>> = EVENT_PAYLOAD_SCHEMAS,
  currentVersion: number | string = FILTER_SCHEMA_VERSION,
): boolean {
  return checkFilterStaleness(rule, schemas, currentVersion).stale;
}

/** Alias to {@link isFilterRuleStale}. */
export const isCompiledFilterStale = isFilterRuleStale;

// ----------------------------------------------------
// Public parse function
// ----------------------------------------------------

/**
 * Parses a filter expression string into a structured, compiled {@link CompiledFilterRule}.
 * Returns a rule that is fully compatible with {@link FilterRule} while carrying
 * schemaVersion, digest, and evaluation helpers.
 *
 * @param input The raw filter expression string.
 * @param options Optional limits on tokens ({@link MAX_FILTER_TOKENS}) and depth ({@link MAX_FILTER_DEPTH}).
 * @throws {@link FilterTokenLimitError} if token count exceeds maxTokens.
 * @throws {@link FilterDepthLimitError} if parentheses nesting depth exceeds maxDepth.
 * @throws {@link FilterParseError} on invalid syntax, unknown fields, or type mismatches.
 */
export function parseFilterExpression(
  input: string,
  options: CompileFilterOptions = {},
): CompiledFilterRule {
  return compileFilterExpression(input, options);
}

// ----------------------------------------------------
// Evaluator
// ----------------------------------------------------

/** Why a filter rule allowed or denied an event, for dry-run diagnostics. */
export type FilterRuleDiagnosticReason =
  | "event-name-mismatch"
  | "missing-field"
  | "predicate-false";

/** Diagnostic result of evaluating one filter rule against one event. */
export interface FilterRuleDiagnostic {
  matched: boolean;
  /** Set when `matched` is false. */
  reason?: FilterRuleDiagnosticReason;
  /** Payload field responsible for a `missing-field` result. */
  field?: string;
}

/**
 * Evaluates a parsed FilterRule and explains a denial.
 *
 * A comparison against an absent (or null) payload field reports
 * `"missing-field"`; the same comparison against a present field that does
 * not satisfy the predicate reports `"predicate-false"`. Both deny, so live
 * allow-or-deny behavior is unchanged.
 *
 * @param rule The parsed filter rule.
 * @param event The DecodedEvent to evaluate.
 */
export function evaluateFilterRuleDiagnostic(
  rule: FilterRule,
  event: DecodedEvent,
): FilterRuleDiagnostic {
  const payload = event.payload as Record<string, unknown>;

  // Check event name match if specified
  if (rule.eventName && rule.eventName !== payload.name) {
    return { matched: false, reason: "event-name-mismatch" };
  }

  // If there's no condition, matching event name (or any event if unset) is enough
  if (!rule.condition) {
    return { matched: true };
  }

  const result = evaluateNode(rule.condition, payload);
  if (result.matched) {
    return { matched: true };
  }
  if (result.missingField !== undefined) {
    return { matched: false, reason: "missing-field", field: result.missingField };
  }
  return { matched: false, reason: "predicate-false" };
}

/**
 * Evaluates a parsed FilterRule against a DecodedEvent purely (no eval, no side effects).
 *
 * @param rule The parsed filter rule.
 * @param event The DecodedEvent to evaluate.
 * @returns boolean true if the event satisfies the rule, false otherwise.
 */
export function evaluateFilterRule(rule: FilterRule, event: DecodedEvent): boolean {
  return evaluateFilterRuleDiagnostic(rule, event).matched;
}

interface NodeResult {
  matched: boolean;
  /** Set when a comparison could not run because the payload field is absent. */
  missingField?: string;
}

function evaluateNode(node: ExprNode, payload: Record<string, unknown>): NodeResult {
  if (node.type === "logical") {
    if (node.op === "and") {
      const left = evaluateNode(node.left, payload);
      return left.matched ? evaluateNode(node.right, payload) : left;
    }
    const left = evaluateNode(node.left, payload);
    if (left.matched) {
      return left;
    }
    const right = evaluateNode(node.right, payload);
    if (right.matched) {
      return right;
    }
    // Neither branch matched. Prefer the missing field: it is the actionable
    // difference between a false predicate and an event that lacks the field.
    return left.missingField !== undefined ? left : right;
  }

  if (node.type === "comparison") {
    const rawVal = payload[node.field];
    if (rawVal === undefined || rawVal === null) {
      return { matched: false, missingField: node.field };
    }

    return { matched: compareValues(rawVal, node.op, node.value) };
  }

  return { matched: false };
}

/** Combined dry-run outcome for expression and amount-threshold filtering. */
export type FilterDryRunDiagnosticReason =
  | "matched"
  | FilterRuleDiagnosticReason
  | "below-threshold";

/** Diagnostic result of a dry-run filter evaluation. */
export interface FilterDryRunDiagnostic {
  matched: boolean;
  reason: FilterDryRunDiagnosticReason;
  /** Payload field responsible for a `missing-field` or `below-threshold` result. */
  field?: string;
  /** Configured minimum, in atomic 7-decimal units, for a threshold denial. */
  threshold?: bigint;
}

/**
 * Dry-run evaluation of a filter expression plus optional USDC thresholds.
 *
 * Reports one reason per event: `"matched"`, `"event-name-mismatch"`,
 * `"missing-field"`, `"predicate-false"`, or `"below-threshold"`. The
 * expression is evaluated first (as in the live path), then the threshold.
 * Live callers should keep using {@link evaluateFilterRule} and
 * {@link meetsThreshold}; this helper only adds diagnostics.
 */
export function evaluateFilterDryRun(
  rule: FilterRule,
  event: DecodedEvent,
  thresholds?: AmountThresholds,
): FilterDryRunDiagnostic {
  const ruleDiagnostic = evaluateFilterRuleDiagnostic(rule, event);
  if (!ruleDiagnostic.matched) {
    return ruleDiagnostic.reason === "missing-field"
      ? { matched: false, reason: "missing-field", field: ruleDiagnostic.field }
      : { matched: false, reason: ruleDiagnostic.reason ?? "predicate-false" };
  }

  const thresholdDiagnostic = evaluateThresholdDiagnostic(event, thresholds);
  if (!thresholdDiagnostic.passed) {
    if (thresholdDiagnostic.reason === "missing-field") {
      return { matched: false, reason: "missing-field", field: thresholdDiagnostic.field };
    }
    return {
      matched: false,
      reason: "below-threshold",
      field: thresholdDiagnostic.field,
      threshold: thresholdDiagnostic.threshold,
    };
  }

  return { matched: true, reason: "matched" };
}

function compareValues(
  actual: unknown,
  op: ComparisonOp,
  literal: LiteralValue,
  isUsdcAmount = false,
): boolean {
  // BigInt actual value comparison (USDC atomic amounts or integer counts like shares)
  if (typeof actual === "bigint") {
    let targetBigInt: bigint;
    if (literal.kind === "usdc") {
      targetBigInt = literal.atomic;
    } else if (literal.kind === "number") {
      const raw = literal.raw ?? String(literal.value);
      targetBigInt = parseUsdcStringToUnits(raw);
    } else {
      if (literal.kind !== "number" || !Number.isInteger(literal.value)) {
        return false;
      }
      targetBigInt = BigInt(literal.value);
    }

    switch (op) {
      case "==":
        return actual === targetBigInt;
      case "!=":
        return actual !== targetBigInt;
      case "<":
        return actual < targetBigInt;
      case "<=":
        return actual <= targetBigInt;
      case ">":
        return actual > targetBigInt;
      case ">=":
        return actual >= targetBigInt;
    }
  }

  // Number actual value comparison (e.g. claimId, confidence, side, ledger)
  if (typeof actual === "number") {
    if (literal.kind !== "number") {
      return false;
    }
    const targetNum = literal.value;

    switch (op) {
      case "==":
        return actual === targetNum;
      case "!=":
        return actual !== targetNum;
      case "<":
        return actual < targetNum;
      case "<=":
        return actual <= targetNum;
      case ">":
        return actual > targetNum;
      case ">=":
        return actual >= targetNum;
    }
  }

  // String actual value comparison (e.g. creator, category, question)
  if (typeof actual === "string") {
    if (literal.kind !== "string") return false;
    const targetStr = literal.value;
    switch (op) {
      case "==":
        return actual === targetStr;
      case "!=":
        return actual !== targetStr;
      default:
        return false;
    }
  }

  // Boolean actual value comparison
  if (typeof actual === "boolean") {
    if (literal.kind !== "boolean") return false;
    switch (op) {
      case "==":
        return actual === literal.value;
      case "!=":
        return actual !== literal.value;
      default:
        return false;
    }
  }

  return false;
}

// ----------------------------------------------------
// Explanation tree (operator diagnostics)
// ----------------------------------------------------

/** Default maximum number of nodes in a filter explanation tree. */
export const MAX_EXPLANATION_NODES = 64;

/**
 * Default maximum depth of a filter explanation tree (the root is depth 0).
 * Left-deep `and`/`or` chains nest one level per operator, so this is set
 * above what a {@link MAX_FILTER_TOKENS}-bounded expression normally needs.
 */
export const MAX_EXPLANATION_DEPTH = 32;

/** Default maximum length, in characters, of one node's `reason` string. */
export const MAX_EXPLANATION_REASON_LENGTH = 96;

/** Kind of node in a filter explanation tree; mirrors the rule and its AST. */
export type FilterExplanationNodeKind =
  | "rule"
  | "event-name"
  | "and"
  | "or"
  | "comparison"
  | "threshold";

/** Outcome of one explanation node. */
export type FilterExplanationOutcome =
  | "matched"
  | "event-name-mismatch"
  | "missing-field"
  | "predicate-false"
  | "below-threshold"
  | "not-configured"
  | "not-evaluated";

/** One node of a filter explanation tree. Contains no payload values. */
export interface FilterExplanationNode {
  kind: FilterExplanationNodeKind;
  /** True when this node allowed the event. False for a failed or skipped node. */
  matched: boolean;
  outcome: FilterExplanationOutcome;
  /** Short, bounded, redacted reason for operators. */
  reason: string;
  /** Child nodes in AST order (left before right). */
  children?: FilterExplanationNode[];
  /** Number of descendants dropped by the node or depth bound, when non-zero. */
  omitted?: number;
}

/** Bounded, deterministic explanation of a filter decision. */
export interface FilterExplanation {
  /** Same result as {@link evaluateFilterRule} (or {@link evaluateFilterDryRun} with thresholds). */
  matched: boolean;
  /** Same reason as {@link evaluateFilterDryRun}. */
  reason: FilterDryRunDiagnosticReason;
  root: FilterExplanationNode;
  /** Nodes present in `root`, including the root. */
  nodeCount: number;
  /** True when the node or depth bound dropped part of the tree. */
  truncated: boolean;
}

/** Options for {@link explainFilterRule}. */
export interface FilterExplanationOptions {
  /** Also explain the amount thresholds, evaluated after the expression as in the live path. */
  thresholds?: AmountThresholds;
  /** Maximum nodes in the output tree (minimum 1). Defaults to {@link MAX_EXPLANATION_NODES}. */
  maxNodes?: number;
  /** Maximum depth of the output tree (minimum 0). Defaults to {@link MAX_EXPLANATION_DEPTH}. */
  maxDepth?: number;
  /** Maximum characters per reason (minimum 8). Defaults to {@link MAX_EXPLANATION_REASON_LENGTH}. */
  maxReasonLength?: number;
}

interface ExplainedNode extends NodeResult {
  node: FilterExplanationNode;
}

/** Placeholder shown instead of any string literal, which may hold an address or message text. */
const REDACTED_STRING = "<redacted>";

/** Identifier shape accepted by the lexer; anything else is not echoed. */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_-]*$/;

function safeIdentifier(text: unknown): string {
  return typeof text === "string" && SAFE_IDENTIFIER.test(text) ? text : "<field>";
}

function formatAtomicUsdc(atomic: bigint): string {
  const negative = atomic < 0n;
  const abs = negative ? -atomic : atomic;
  const whole = abs / USDC_SCALE;
  const frac = (abs % USDC_SCALE).toString().padStart(7, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""} USDC`;
}

/** Render a literal from the rule without exposing string contents. */
function describeLiteral(literal: LiteralValue): string {
  switch (literal.kind) {
    case "string":
      return REDACTED_STRING;
    case "boolean":
      return literal.value ? "true" : "false";
    case "usdc":
      return formatAtomicUsdc(literal.atomic);
    case "number": {
      const raw = literal.raw ?? String(literal.value);
      return /^\d+(\.\d+)?$/.test(raw) ? raw : "<number>";
    }
  }
}

function explainCondition(node: ExprNode, payload: Record<string, unknown>): ExplainedNode {
  if (node.type === "logical") {
    const left = explainCondition(node.left, payload);
    let result: NodeResult;
    let right: ExplainedNode;
    const shortCircuit = node.op === "and" ? !left.matched : left.matched;
    if (shortCircuit) {
      // The live evaluator never looks at the right branch here.
      result = left;
      right = { matched: false, node: skippedNode(node.right) };
    } else {
      right = explainCondition(node.right, payload);
      result =
        node.op === "and" || right.matched || left.missingField === undefined ? right : left;
    }
    const outcome = outcomeOf(result);
    const reason =
      node.op === "and"
        ? result.matched
          ? "and: both sides matched"
          : shortCircuit
            ? "and: left side failed; right side not evaluated"
            : "and: right side failed"
        : result.matched
          ? shortCircuit
            ? "or: left side matched; right side not evaluated"
            : "or: right side matched"
          : "or: neither side matched";
    return {
      ...result,
      node: { kind: node.op, matched: result.matched, outcome, reason, children: [left.node, right.node] },
    };
  }

  const field = safeIdentifier(node.field);
  const predicate = `${field} ${node.op} ${describeLiteral(node.value)}`;
  const rawVal = payload[node.field];
  if (rawVal === undefined || rawVal === null) {
    return {
      matched: false,
      missingField: node.field,
      node: {
        kind: "comparison",
        matched: false,
        outcome: "missing-field",
        reason: `${predicate}: field absent from payload`,
      },
    };
  }
  const matched = compareValues(rawVal, node.op, node.value);
  return {
    matched,
    node: {
      kind: "comparison",
      matched,
      outcome: matched ? "matched" : "predicate-false",
      reason: `${predicate}: ${matched ? "true" : "false"}`,
    },
  };
}

function skippedNode(node: ExprNode): FilterExplanationNode {
  if (node.type === "logical") {
    return {
      kind: node.op,
      matched: false,
      outcome: "not-evaluated",
      reason: `${node.op}: not evaluated`,
      children: [skippedNode(node.left), skippedNode(node.right)],
    };
  }
  return {
    kind: "comparison",
    matched: false,
    outcome: "not-evaluated",
    reason: `${safeIdentifier(node.field)} ${node.op} ${describeLiteral(node.value)}: not evaluated`,
  };
}

function outcomeOf(result: NodeResult): FilterExplanationOutcome {
  if (result.matched) return "matched";
  return result.missingField !== undefined ? "missing-field" : "predicate-false";
}

function thresholdNode(
  event: DecodedEvent,
  thresholds: AmountThresholds,
  evaluate: boolean,
): { passed: boolean; diagnostic?: ThresholdDiagnostic; node: FilterExplanationNode } {
  if (!evaluate) {
    return {
      passed: false,
      node: {
        kind: "threshold",
        matched: false,
        outcome: "not-evaluated",
        reason: "amount threshold: not evaluated",
      },
    };
  }
  const diagnostic = evaluateThresholdDiagnostic(event, thresholds);
  const field = diagnostic.field ?? "amount";
  const minimum = diagnostic.threshold === undefined ? "" : formatAtomicUsdc(diagnostic.threshold);
  let outcome: FilterExplanationOutcome;
  let reason: string;
  switch (diagnostic.reason) {
    case "not-configured":
      outcome = "not-configured";
      reason = "amount threshold: none applies to this event";
      break;
    case "passed":
      outcome = "matched";
      reason = `amount threshold: ${field} >= ${minimum}`;
      break;
    case "missing-field":
      outcome = "missing-field";
      reason = `amount threshold: ${field} absent from payload (minimum ${minimum})`;
      break;
    case "below-threshold":
      outcome = "below-threshold";
      reason = `amount threshold: ${field} below minimum ${minimum}`;
      break;
  }
  return {
    passed: diagnostic.passed,
    diagnostic,
    node: { kind: "threshold", matched: diagnostic.passed, outcome, reason },
  };
}

function clampOption(value: number | undefined, fallback: number, min: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.floor(value));
}

function clipReason(reason: string, max: number): string {
  return reason.length <= max ? reason : `${reason.slice(0, max - 1)}…`;
}

function countNodes(node: FilterExplanationNode): number {
  let total = 1;
  for (const child of node.children ?? []) total += countNodes(child);
  return total;
}

/**
 * Copy `node` into a tree of at most `budget.remaining` nodes and `maxDepth`
 * levels, in pre-order. Dropped descendants are counted on their parent's
 * `omitted` field so the operator can see the tree was cut.
 */
function boundTree(
  node: FilterExplanationNode,
  depth: number,
  budget: { remaining: number; truncated: boolean },
  limits: { maxDepth: number; maxReasonLength: number },
): FilterExplanationNode {
  budget.remaining -= 1;
  const out: FilterExplanationNode = {
    kind: node.kind,
    matched: node.matched,
    outcome: node.outcome,
    reason: clipReason(node.reason, limits.maxReasonLength),
  };
  const children = node.children ?? [];
  if (children.length === 0) return out;

  const kept: FilterExplanationNode[] = [];
  let omitted = 0;
  for (const child of children) {
    if (depth + 1 > limits.maxDepth || budget.remaining <= 0) {
      omitted += countNodes(child);
      continue;
    }
    kept.push(boundTree(child, depth + 1, budget, limits));
  }
  if (kept.length > 0) out.children = kept;
  if (omitted > 0) {
    out.omitted = omitted;
    budget.truncated = true;
  }
  return out;
}

/**
 * Explains a filter decision as a deterministic tree that mirrors the rule:
 * a `rule` root, an `event-name` node when the rule names an event, the
 * condition AST (`and` / `or` / `comparison`), and a `threshold` node when
 * thresholds are given. Each node says whether it matched and why.
 *
 * The result is a pure diagnostic: `matched` and `reason` always agree with
 * {@link evaluateFilterRule} / {@link evaluateFilterDryRun}, short-circuited
 * branches are reported as `not-evaluated`, and the live path is untouched.
 *
 * Privacy: reasons never contain payload values. String literals from the
 * rule (which may hold an address, a chat or route identity, or message text)
 * are shown as `<redacted>`; only field names, operators, numeric literals,
 * and USDC amounts from the rule itself appear.
 *
 * Bounds: at most `maxNodes` nodes, `maxDepth` levels and `maxReasonLength`
 * characters per reason; dropped subtrees are counted in `omitted`.
 */
export function explainFilterRule(
  rule: FilterRule,
  event: DecodedEvent,
  options: FilterExplanationOptions = {},
): FilterExplanation {
  const maxNodes = clampOption(options.maxNodes, MAX_EXPLANATION_NODES, 1);
  const maxDepth = clampOption(options.maxDepth, MAX_EXPLANATION_DEPTH, 0);
  const maxReasonLength = clampOption(options.maxReasonLength, MAX_EXPLANATION_REASON_LENGTH, 8);
  const payload = event.payload as Record<string, unknown>;
  const children: FilterExplanationNode[] = [];

  let reason: FilterDryRunDiagnosticReason = "matched";
  let expressionMatched = true;

  if (rule.eventName) {
    const nameMatched = rule.eventName === payload.name;
    const expected = safeIdentifier(rule.eventName);
    children.push({
      kind: "event-name",
      matched: nameMatched,
      outcome: nameMatched ? "matched" : "event-name-mismatch",
      reason: nameMatched
        ? `event is ${expected}`
        : `event is not ${expected}`,
    });
    if (!nameMatched) {
      expressionMatched = false;
      reason = "event-name-mismatch";
    }
  }

  if (rule.condition) {
    if (expressionMatched) {
      const result = explainCondition(rule.condition, payload);
      children.push(result.node);
      if (!result.matched) {
        expressionMatched = false;
        reason = result.missingField !== undefined ? "missing-field" : "predicate-false";
      }
    } else {
      children.push(skippedNode(rule.condition));
    }
  }

  let matched = expressionMatched;
  if (options.thresholds) {
    const threshold = thresholdNode(event, options.thresholds, expressionMatched);
    children.push(threshold.node);
    if (expressionMatched && !threshold.passed) {
      matched = false;
      reason = threshold.diagnostic?.reason === "missing-field" ? "missing-field" : "below-threshold";
    }
  }

  const rootReason = matched
    ? "rule matched: event allowed"
    : `rule failed (${reason}): event denied`;
  const full: FilterExplanationNode = {
    kind: "rule",
    matched,
    outcome: matched ? "matched" : reason === "matched" ? "predicate-false" : reason,
    reason: rootReason,
    children,
  };

  const budget = { remaining: maxNodes, truncated: false };
  const root = boundTree(full, 0, budget, { maxDepth, maxReasonLength });
  return {
    matched,
    reason,
    root,
    nodeCount: countNodes(root),
    truncated: budget.truncated,
  };
}

/**
 * Renders an explanation as indented plain text, one line per node, for logs
 * or an operator reply. Output size is bounded by the explanation's own bounds.
 */
export function renderFilterExplanation(explanation: FilterExplanation): string {
  const lines: string[] = [];
  const walk = (node: FilterExplanationNode, depth: number): void => {
    const mark = node.outcome === "not-evaluated" ? "-" : node.matched ? "✓" : "✗";
    lines.push(`${"  ".repeat(depth)}${mark} [${node.kind}] ${node.reason}`);
    for (const child of node.children ?? []) walk(child, depth + 1);
    if (node.omitted) lines.push(`${"  ".repeat(depth + 1)}… ${node.omitted} more node(s) omitted`);
  };
  walk(explanation.root, 0);
  return lines.join("\n");
}
