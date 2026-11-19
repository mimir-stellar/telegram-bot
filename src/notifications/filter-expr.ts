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
 */

import { createHash } from "node:crypto";

import type { DecodedEvent } from "../stellar/decode.js";

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

  constructor(message: string, position: number) {
    super(`At character ${position}: ${message}`);
    this.name = "FilterParseError";
    this.position = position;
  }
}

/** Supported comparison operators. */
export type ComparisonOp = "==" | "!=" | "<" | "<=" | ">" | ">=";

/** Value literals supported by the AST. */
export type LiteralValue =
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "usdc"; atomic: bigint; rawDecimal: string };

export type ExprNode =
  | { type: "logical"; op: "and" | "or"; left: ExprNode; right: ExprNode }
  | {
      type: "comparison";
      op: ComparisonOp;
      field: string;
      fieldPos: number;
      value: LiteralValue;
      valuePos: number;
    };

export interface FilterRule {
  eventName?: string;
  eventNamePos?: number;
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
      return { type: "EOF", text: "", pos: this.pos };
    }

    const start = this.pos;
    const ch = this.input[this.pos];
    if (ch === undefined) {
      return { type: "EOF", text: "", pos: this.pos };
    }

    if (ch === "(") {
      this.pos++;
      return { type: "LPAREN", text: "(", pos: start };
    }
    if (ch === ")") {
      this.pos++;
      return { type: "RPAREN", text: ")", pos: start };
    }

    // Comparison operators
    if (ch === "=") {
      this.pos++;
      if (this.pos < this.input.length && this.input[this.pos] === "=") {
        this.pos++;
        return { type: "OP", text: "==", pos: start };
      }
      return { type: "OP", text: "==", pos: start }; // normalize '=' to '=='
    }
    if (ch === "!" && this.pos + 1 < this.input.length && this.input[this.pos + 1] === "=") {
      this.pos += 2;
      return { type: "OP", text: "!=", pos: start };
    }
    if (ch === "<") {
      this.pos++;
      if (this.pos < this.input.length && this.input[this.pos] === "=") {
        this.pos++;
        return { type: "OP", text: "<=", pos: start };
      }
      return { type: "OP", text: "<", pos: start };
    }
    if (ch === ">") {
      this.pos++;
      if (this.pos < this.input.length && this.input[this.pos] === "=") {
        this.pos++;
        return { type: "OP", text: ">=", pos: start };
      }
      return { type: "OP", text: ">", pos: start };
    }

    // Quoted strings: '...' or "..."
    if (ch === "'" || ch === '"') {
      const quote = ch;
      this.pos++;
      let str = "";
      while (this.pos < this.input.length) {
        const c = this.input[this.pos];
        if (c === "\\") {
          this.pos++;
          if (this.pos >= this.input.length) {
            throw new FilterParseError("Unterminated string escape", this.pos);
          }
          str += this.input[this.pos] ?? "";
          this.pos++;
        } else if (c === quote) {
          this.pos++;
          return { type: "STRING", text: str, pos: start, value: str };
        } else {
          str += c;
          this.pos++;
        }
      }
      throw new FilterParseError(`Unterminated string starting with ${quote}`, start);
    }

    // Dollar-prefixed USDC literal: e.g. $100, $5.50
    if (ch === "$") {
      this.pos++;
      const numStr = this.readNumberString();
      if (!numStr) {
        throw new FilterParseError("Expected number after '$'", start);
      }
      return {
        type: "USDC",
        text: "$" + numStr,
        pos: start,
        value: parseUsdcStringToUnits(numStr, start),
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
          value: parseUsdcStringToUnits(numStr, start),
        };
      }
      // Revert if not USDC
      this.pos = savedPos;
      return {
        type: "NUMBER",
        text: numStr,
        pos: start,
        value: numStr.includes(".") ? parseFloat(numStr) : parseInt(numStr, 10),
      };
    }

    // Word: identifier or keyword
    if (this.isIdentStart(ch)) {
      const word = this.readWord();
      const lower = word.toLowerCase();
      if (lower === "where") {
        return { type: "WHERE", text: word, pos: start };
      }
      if (lower === "and") {
        return { type: "AND", text: word, pos: start };
      }
      if (lower === "or") {
        return { type: "OR", text: word, pos: start };
      }
      return { type: "IDENTIFIER", text: word, pos: start };
    }

    throw new FilterParseError(`Unexpected character '${ch}'`, start);
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
  const parts = numStr.split(".");
  const wholeStr = parts[0] ?? "";
  const fracStr = parts[1] ?? "";

  if (fracStr.length > 7) {
    throw new FilterParseError(
      `USDC amount "${numStr}" exceeds maximum precision of 7 decimals`,
      pos,
    );
  }

  const whole = BigInt(wholeStr);
  const frac = BigInt(fracStr.padEnd(7, "0"));
  return whole * USDC_SCALE + frac;
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
    return this.currentToken;
  }

  public parseRule(rawExpression: string): FilterRule {
    let eventName: string | undefined;
    let eventNamePos: number | undefined;

    // Check if expression starts with an event name (identifier not equal to 'where')
    if (this.currentToken.type === "IDENTIFIER") {
      eventName = this.currentToken.text;
      eventNamePos = this.currentToken.pos;
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
          `Unexpected token "${this.currentToken.text}". Expected event name or 'where'`,
          this.currentToken.pos,
        );
      } else {
        throw new FilterParseError(
          `Expected 'where' or end of expression, got "${this.currentToken.text}"`,
          this.currentToken.pos,
        );
      }
    }

    if (this.currentToken.type !== "EOF") {
      throw new FilterParseError(
        `Unexpected extra input "${this.currentToken.text}"`,
        this.currentToken.pos,
      );
    }

    // Validate fields against schema if eventName is specified
    if (condition && eventName) {
      validateConditionAgainstSchema(condition, eventName, this.schemas);
    }

    return {
      eventName,
      eventNamePos,
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
      this.advance();
      const expr = this.parseExpression();
      if ((this.currentToken.type as TokenType) !== "RPAREN") {
        throw new FilterParseError("Expected closing ')'", this.currentToken.pos);
      }
      this.advance();
      return expr;
    }

    return this.parseComparison();
  }

  private parseComparison(): ExprNode {
    if ((this.currentToken.type as TokenType) !== "IDENTIFIER") {
      throw new FilterParseError(
        `Expected field name, found "${this.currentToken.text || "EOF"}"`,
        this.currentToken.pos,
      );
    }

    const field = this.currentToken.text;
    const fieldPos = this.currentToken.pos;
    this.advance();

    if ((this.currentToken.type as TokenType) !== "OP") {
      throw new FilterParseError(
        `Expected comparison operator (==, !=, <, <=, >, >=), found "${this.currentToken.text || "EOF"}"`,
        this.currentToken.pos,
      );
    }

    const op = this.currentToken.text as ComparisonOp;
    this.advance();

    const valuePos = this.currentToken.pos;
    const value = this.parseLiteral();

    return {
      type: "comparison",
      op,
      field,
      fieldPos,
      value,
      valuePos,
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
      return { kind: "number", value: tok.value as number };
    }

    if (tok.type === "IDENTIFIER") {
      const lower = tok.text.toLowerCase();
      if (lower === "true" || lower === "false") {
        this.advance();
        return { kind: "boolean", value: lower === "true" };
      }
    }

    throw new FilterParseError(
      `Expected literal value (string, number, USDC amount, or boolean), got "${tok.text || "EOF"}"`,
      tok.pos,
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

  function traverse(node: ExprNode): void {
    if (node.type === "logical") {
      traverse(node.left);
      traverse(node.right);
      return;
    }

    const fieldDef = currentSchema[node.field];
    if (!fieldDef) {
      throw new FilterParseError(
        `Unknown field "${node.field}" for event "${eventName}"`,
        node.fieldPos,
      );
    }

    // Check type compatibility
    switch (fieldDef.type) {
      case "string":
        if (node.value.kind !== "string") {
          throw new FilterParseError(
            `Field "${node.field}" is a string, but got ${node.value.kind} literal`,
            node.valuePos,
          );
        }
        if (node.op !== "==" && node.op !== "!=") {
          throw new FilterParseError(
            `Operator "${node.op}" cannot be used on string field "${node.field}" (only == and != are supported)`,
            node.fieldPos,
          );
        }
        break;

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

      case "bigint":
        // Bigint fields (like stake, amount) can be compared to usdc literals or numbers
        if (node.value.kind !== "usdc" && node.value.kind !== "number") {
          throw new FilterParseError(
            `Field "${node.field}" is a numeric/USDC amount, but got ${node.value.kind} literal`,
            node.valuePos,
          );
        }
        break;

      case "number":
        if (node.value.kind !== "number") {
          throw new FilterParseError(
            `Field "${node.field}" is a number, but got ${node.value.kind} literal`,
            node.valuePos,
          );
        }
        break;
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

/**
 * Evaluates a parsed FilterRule against a DecodedEvent purely (no eval, no side effects).
 *
 * @param rule The parsed filter rule.
 * @param event The DecodedEvent to evaluate.
 * @returns boolean true if the event satisfies the rule, false otherwise.
 */
export function evaluateFilterRule(rule: FilterRule, event: DecodedEvent): boolean {
  const payload = event.payload as Record<string, unknown>;

  // Check event name match if specified
  if (rule.eventName && rule.eventName !== payload.name) {
    return false;
  }

  // If there's no condition, matching event name (or any event if unset) is enough
  if (!rule.condition) {
    return true;
  }

  return evaluateNode(rule.condition, payload);
}

function evaluateNode(node: ExprNode, payload: Record<string, unknown>): boolean {
  if (node.type === "logical") {
    if (node.op === "and") {
      return evaluateNode(node.left, payload) && evaluateNode(node.right, payload);
    }
    if (node.op === "or") {
      return evaluateNode(node.left, payload) || evaluateNode(node.right, payload);
    }
  }

  if (node.type === "comparison") {
    const rawVal = payload[node.field];
    if (rawVal === undefined || rawVal === null) {
      return false;
    }

    return compareValues(rawVal, node.op, node.value);
  }

  return false;
}

function compareValues(
  actual: unknown,
  op: ComparisonOp,
  literal: LiteralValue,
): boolean {
  // BigInt actual value comparison (e.g. stake, amount in DecodedEvent)
  if (typeof actual === "bigint") {
    let targetBigInt: bigint;
    if (literal.kind === "usdc") {
      targetBigInt = literal.atomic;
    } else if (literal.kind === "number") {
      targetBigInt = BigInt(Math.floor(literal.value)) * USDC_SCALE;
    } else {
      return false;
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

  // Number actual value comparison (e.g. claimId, confidence, side)
  if (typeof actual === "number") {
    let targetNum: number;
    if (literal.kind === "number") {
      targetNum = literal.value;
    } else if (literal.kind === "usdc") {
      targetNum = Number(literal.atomic) / Number(USDC_SCALE);
    } else {
      return false;
    }

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
