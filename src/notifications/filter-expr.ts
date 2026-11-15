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

import type { DecodedEvent } from "../stellar/decode.js";
import { USDC_ATOMIC_SCALE } from "./amount-threshold.js";

/** USDC atomic unit divisor (7 decimal places). */
export const USDC_SCALE = USDC_ATOMIC_SCALE;

/**
 * Expected schema type for fields.
 */
export type FieldType = "string" | "number" | "bigint" | "boolean";

/**
 * Semantic domain unit for numeric/bigint fields so mixed-unit comparisons
 * (e.g. comparing a USDC atomic amount with a numeric identifier or ledger sequence)
 * are rejected at parse/startup validation time before live polling starts.
 */
export type FieldUnit = "usdc_amount" | "identifier" | "ledger" | "shares" | "scalar";

export interface FieldDefinition {
  type: FieldType;
  /** Whether the field is an amount in atomic 7-decimal USDC units. */
  isUsdcAmount?: boolean;
  /** Semantic domain unit for numeric/bigint comparisons. */
  unit?: FieldUnit;
}

/** Built-in top-level DecodedEvent metadata fields available across all events. */
export const BUILTIN_EVENT_FIELDS: Record<string, FieldDefinition> = {
  ledger: { type: "number", unit: "ledger" },
};

/**
 * Known fields and types for each event payload name.
 */
export const EVENT_PAYLOAD_SCHEMAS: Record<string, Record<string, FieldDefinition>> = {
  claim_created: {
    name: { type: "string" },
    claimId: { type: "number", unit: "identifier" },
    creator: { type: "string" },
    category: { type: "string" },
    title: { type: "string" },
  },
  claim_challenged: {
    name: { type: "string" },
    claimId: { type: "number", unit: "identifier" },
    challenger: { type: "string" },
    stake: { type: "bigint", isUsdcAmount: true, unit: "usdc_amount" },
  },
  claim_resolved: {
    name: { type: "string" },
    claimId: { type: "number", unit: "identifier" },
    winnerSide: { type: "number", unit: "scalar" },
    summary: { type: "string" },
    confidence: { type: "number", unit: "scalar" },
    evidenceHash: { type: "string" },
    resolver: { type: "string" },
  },
  claim_cancelled: {
    name: { type: "string" },
    claimId: { type: "number", unit: "identifier" },
  },
  market_settled: {
    name: { type: "string" },
    claimId: { type: "number", unit: "identifier" },
    totalPaid: { type: "bigint", isUsdcAmount: true, unit: "usdc_amount" },
    totalFees: { type: "bigint", isUsdcAmount: true, unit: "usdc_amount" },
    owedToChallengers: { type: "bigint", isUsdcAmount: true, unit: "usdc_amount" },
    dust: { type: "bigint", isUsdcAmount: true, unit: "usdc_amount" },
  },
  challenger_paid: {
    name: { type: "string" },
    claimId: { type: "number", unit: "identifier" },
    challenger: { type: "string" },
    stake: { type: "bigint", isUsdcAmount: true, unit: "usdc_amount" },
    gross: { type: "bigint", isUsdcAmount: true, unit: "usdc_amount" },
    fee: { type: "bigint", isUsdcAmount: true, unit: "usdc_amount" },
    net: { type: "bigint", isUsdcAmount: true, unit: "usdc_amount" },
  },
  fee_claimed: {
    name: { type: "string" },
    recipient: { type: "string" },
    amount: { type: "bigint", isUsdcAmount: true, unit: "usdc_amount" },
  },
  withdrawal: {
    name: { type: "string" },
    to: { type: "string" },
    amount: { type: "bigint", isUsdcAmount: true, unit: "usdc_amount" },
  },
  withdrawal_pending: {
    name: { type: "string" },
    to: { type: "string" },
    amount: { type: "bigint", isUsdcAmount: true, unit: "usdc_amount" },
  },
  market_created: {
    name: { type: "string" },
    marketId: { type: "number", unit: "identifier" },
    captain: { type: "string" },
    deadline: { type: "number", unit: "scalar" },
    feeBps: { type: "number", unit: "scalar" },
    question: { type: "string" },
    category: { type: "string" },
  },
  deposited: {
    name: { type: "string" },
    marketId: { type: "number", unit: "identifier" },
    side: { type: "number", unit: "scalar" },
    participant: { type: "string" },
    amount: { type: "bigint", isUsdcAmount: true, unit: "usdc_amount" },
    shares: { type: "bigint", unit: "shares" },
  },
  withdrawn: {
    name: { type: "string" },
    marketId: { type: "number", unit: "identifier" },
    side: { type: "number", unit: "scalar" },
    participant: { type: "string" },
    amount: { type: "bigint", isUsdcAmount: true, unit: "usdc_amount" },
  },
  resolved: {
    name: { type: "string" },
    marketId: { type: "number", unit: "identifier" },
    result: { type: "number", unit: "scalar" },
    poolA: { type: "bigint", isUsdcAmount: true, unit: "usdc_amount" },
    poolB: { type: "bigint", isUsdcAmount: true, unit: "usdc_amount" },
  },
  claimed: {
    name: { type: "string" },
    marketId: { type: "number", unit: "identifier" },
    participant: { type: "string" },
    gross: { type: "bigint", isUsdcAmount: true, unit: "usdc_amount" },
    fee: { type: "bigint", isUsdcAmount: true, unit: "usdc_amount" },
    net: { type: "bigint", isUsdcAmount: true, unit: "usdc_amount" },
  },
  fees_claimed: {
    name: { type: "string" },
    recipient: { type: "string" },
    amount: { type: "bigint", isUsdcAmount: true, unit: "usdc_amount" },
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
    amount: { type: "bigint", isUsdcAmount: true, unit: "usdc_amount" },
    admin: { type: "string" },
  },
};

/** Parse / Validation Error with character position. */
export class FilterParseError extends Error {
  public readonly position: number;

  constructor(message: string, position: number) {
    super(`At character ${position}: ${message}`);
    this.name = "FilterParseError";
    this.position = position;
  }
}

/** Validation error raised when a filter expression compares incompatible semantic units. */
export class MixedUnitFilterError extends FilterParseError {
  public readonly code = "MIXED_UNIT_COMPARISON" as const;
  public readonly leftUnit: string;
  public readonly rightUnit: string;

  constructor(
    message: string,
    position: number,
    leftUnit: string,
    rightUnit: string,
  ) {
    super(message, position);
    this.name = "MixedUnitFilterError";
    this.leftUnit = leftUnit;
    this.rightUnit = rightUnit;
  }
}

/** Supported comparison operators. */
export type ComparisonOp = "==" | "!=" | "<" | "<=" | ">" | ">=";

/** Value literals and field operands supported by the AST. */
export type LiteralValue =
  | { kind: "string"; value: string }
  | { kind: "number"; value: number; rawText?: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "usdc"; atomic: bigint; rawDecimal: string }
  | { kind: "ledger"; value: number; rawText: string }
  | { kind: "identifier"; value: number; rawText: string }
  | { kind: "field"; field: string };

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
}

// ----------------------------------------------------
// Lexer / Tokenizer
// ----------------------------------------------------

export type TokenType =
  | "IDENTIFIER"
  | "STRING"
  | "NUMBER"
  | "USDC"
  | "LEDGER"
  | "ID_LITERAL"
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

    // Hash-prefixed identifier literal: e.g. #42
    if (ch === "#") {
      this.pos++;
      const numStr = this.readNumberString();
      if (!numStr) {
        throw new FilterParseError("Expected integer identifier after '#'", start);
      }
      if (numStr.includes(".")) {
        throw new MixedUnitFilterError(
          `Identifier "#${numStr}" must be an integer`,
          start,
          "identifier",
          "decimal",
        );
      }
      return {
        type: "ID_LITERAL",
        text: "#" + numStr,
        pos: start,
        value: parseInt(numStr, 10),
      };
    }

    // Number (digits, optional dot and decimal digits)
    if (this.isDigit(ch)) {
      const numStr = this.readNumberString();
      // Check if immediately followed by optional whitespace and 'USDC' or 'ledger(s)'
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
      if (
        lookaheadWord &&
        (lookaheadWord.toLowerCase() === "ledger" || lookaheadWord.toLowerCase() === "ledgers")
      ) {
        if (numStr.includes(".")) {
          throw new MixedUnitFilterError(
            `Ledger number "${numStr} ${lookaheadWord}" must be an integer`,
            start,
            "ledger",
            "decimal",
          );
        }
        return {
          type: "LEDGER",
          text: `${numStr} ${lookaheadWord}`,
          pos: start,
          value: parseInt(numStr, 10),
        };
      }
      // Revert if not unit-suffixed
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

  constructor(input: string) {
    this.lexer = new Lexer(input);
    this.currentToken = this.lexer.nextToken();
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
      if (EVENT_PAYLOAD_SCHEMAS && !(eventName in EVENT_PAYLOAD_SCHEMAS)) {
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

    // Validate fields and semantic units (both event-scoped and unscoped rules)
    if (condition) {
      if (eventName) {
        validateConditionAgainstSchema(condition, eventName);
      } else {
        validateUnscopedConditionUnits(condition);
      }
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

    if (tok.type === "LEDGER") {
      this.advance();
      return { kind: "ledger", value: tok.value as number, rawText: tok.text };
    }

    if (tok.type === "ID_LITERAL") {
      this.advance();
      return { kind: "identifier", value: tok.value as number, rawText: tok.text };
    }

    if (tok.type === "NUMBER") {
      this.advance();
      return { kind: "number", value: tok.value as number, rawText: tok.text };
    }

    if (tok.type === "IDENTIFIER") {
      const lower = tok.text.toLowerCase();
      if (lower === "true" || lower === "false") {
        this.advance();
        return { kind: "boolean", value: lower === "true" };
      }
      this.advance();
      return { kind: "field", field: tok.text };
    }

    throw new FilterParseError(
      `Expected literal value (string, number, USDC amount, or boolean), got "${tok.text || "EOF"}"`,
      tok.pos,
    );
  }
}

function effectiveUnit(def: FieldDefinition): string {
  if (def.unit) return def.unit;
  if (def.isUsdcAmount) return "usdc_amount";
  return def.type;
}

function resolveUnscopedFieldDef(field: string): FieldDefinition | undefined {
  if (BUILTIN_EVENT_FIELDS[field]) {
    return BUILTIN_EVENT_FIELDS[field];
  }
  let found: FieldDefinition | undefined;
  for (const schema of Object.values(EVENT_PAYLOAD_SCHEMAS)) {
    const def = schema[field];
    if (!def) continue;
    if (!found) {
      found = def;
    } else if (found.type !== def.type || effectiveUnit(found) !== effectiveUnit(def)) {
      return undefined;
    }
  }
  return found;
}

function validateSingleComparison(
  node: Extract<ExprNode, { type: "comparison" }>,
  leftDef: FieldDefinition,
  resolveRightField: (name: string) => FieldDefinition | undefined,
  eventName?: string,
): void {
  const leftUnit = effectiveUnit(leftDef);

  if (node.value.kind === "field") {
    const rightDef = resolveRightField(node.value.field);
    if (!rightDef) {
      if (eventName) {
        throw new FilterParseError(
          `Unknown field "${node.value.field}" for event "${eventName}"`,
          node.valuePos,
        );
      }
      return;
    }
    const rightUnit = effectiveUnit(rightDef);
    if (leftUnit !== rightUnit || leftDef.type !== rightDef.type) {
      throw new MixedUnitFilterError(
        `Mixed-unit comparison: cannot compare ${leftUnit} field "${node.field}" with ${rightUnit} field "${node.value.field}"`,
        node.valuePos,
        leftUnit,
        rightUnit,
      );
    }
    if ((leftDef.type === "string" || leftDef.type === "boolean") && node.op !== "==" && node.op !== "!=") {
      throw new FilterParseError(
        `Operator "${node.op}" cannot be used on ${leftDef.type} field "${node.field}"`,
        node.fieldPos,
      );
    }
    return;
  }

  // Reject mixed-unit comparisons against explicit USDC atomic amount literals
  if (node.value.kind === "usdc" && leftUnit !== "usdc_amount") {
    throw new MixedUnitFilterError(
      `Mixed-unit comparison on field "${node.field}" (${leftUnit}): cannot compare ${leftUnit} with USDC atomic amount "${node.value.rawDecimal}"`,
      node.valuePos,
      leftUnit,
      "usdc_amount",
    );
  }

  // Reject mixed-unit comparisons against explicit ledger sequence literals
  if (node.value.kind === "ledger" && leftUnit !== "ledger") {
    throw new MixedUnitFilterError(
      `Mixed-unit comparison on field "${node.field}" (${leftUnit}): cannot compare ${leftUnit} with ledger number "${node.value.rawText}"`,
      node.valuePos,
      leftUnit,
      "ledger",
    );
  }

  // Reject mixed-unit comparisons against explicit identifier literals (#42)
  if (node.value.kind === "identifier" && leftUnit !== "identifier") {
    throw new MixedUnitFilterError(
      `Mixed-unit comparison on field "${node.field}" (${leftUnit}): cannot compare ${leftUnit} with identifier "${node.value.rawText}"`,
      node.valuePos,
      leftUnit,
      "identifier",
    );
  }

  // Reject fractional decimal comparisons on integer identifiers, ledger numbers, or shares
  if (
    node.value.kind === "number" &&
    (leftUnit === "identifier" || leftUnit === "ledger" || leftUnit === "shares") &&
    !Number.isInteger(node.value.value)
  ) {
    throw new MixedUnitFilterError(
      `Mixed-unit comparison on field "${node.field}" (${leftUnit}): ${leftUnit} requires an integer value, got "${node.value.rawText ?? node.value.value}"`,
      node.valuePos,
      leftUnit,
      "decimal",
    );
  }

  if (
    node.value.kind === "number" &&
    leftUnit === "usdc_amount" &&
    node.value.rawText?.includes(".")
  ) {
    parseUsdcStringToUnits(node.value.rawText, node.valuePos);
  }

  // Check type compatibility
  switch (leftDef.type) {
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
      if (node.value.kind !== "usdc" && node.value.kind !== "number") {
        throw new FilterParseError(
          `Field "${node.field}" is a numeric/USDC amount, but got ${node.value.kind} literal`,
          node.valuePos,
        );
      }
      break;

    case "number":
      if (
        node.value.kind !== "number" &&
        !(leftUnit === "ledger" && node.value.kind === "ledger") &&
        !(leftUnit === "identifier" && node.value.kind === "identifier")
      ) {
        throw new FilterParseError(
          `Field "${node.field}" is a number, but got ${node.value.kind} literal`,
          node.valuePos,
        );
      }
      break;
  }
}

function validateUnscopedConditionUnits(condition: ExprNode): void {
  if (condition.type === "logical") {
    validateUnscopedConditionUnits(condition.left);
    validateUnscopedConditionUnits(condition.right);
    return;
  }
  const leftDef = resolveUnscopedFieldDef(condition.field);
  if (!leftDef) return;
  validateSingleComparison(condition, leftDef, resolveUnscopedFieldDef);
}

/** Validate fields, types, and semantic units in condition against the given event payload schema. */
export function validateConditionAgainstSchema(condition: ExprNode, eventName: string): void {
  const schema = EVENT_PAYLOAD_SCHEMAS[eventName];
  if (!schema) return;
  const currentSchema = schema;
  const resolveScopedField = (name: string): FieldDefinition | undefined =>
    BUILTIN_EVENT_FIELDS[name] ?? currentSchema[name];

  function traverse(node: ExprNode): void {
    if (node.type === "logical") {
      traverse(node.left);
      traverse(node.right);
      return;
    }

    const fieldDef = resolveScopedField(node.field);
    if (!fieldDef) {
      throw new FilterParseError(
        `Unknown field "${node.field}" for event "${eventName}"`,
        node.fieldPos,
      );
    }

    validateSingleComparison(node, fieldDef, resolveScopedField, eventName);
  }

  traverse(condition);
}

// ----------------------------------------------------
// Public parse function
// ----------------------------------------------------

/**
 * Parses a filter expression string into a structured {@link FilterRule}.
 *
 * @throws {@link FilterParseError} on invalid syntax, unknown fields, type mismatches,
 * or mixed-unit comparisons ({@link MixedUnitFilterError}).
 */
export function parseFilterExpression(input: string): FilterRule {
  const parser = new FilterParser(input.trim());
  return parser.parseRule(input);
}

// ----------------------------------------------------
// Evaluator
// ----------------------------------------------------

function readEventFieldValue(
  event: DecodedEvent,
  payload: Record<string, unknown>,
  field: string,
): unknown {
  if (Object.prototype.hasOwnProperty.call(payload, field)) {
    return payload[field];
  }
  if (field === "ledger") {
    return event.ledger;
  }
  return undefined;
}

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

  return evaluateNode(rule.condition, event, payload);
}

function evaluateNode(
  node: ExprNode,
  event: DecodedEvent,
  payload: Record<string, unknown>,
): boolean {
  if (node.type === "logical") {
    if (node.op === "and") {
      return evaluateNode(node.left, event, payload) && evaluateNode(node.right, event, payload);
    }
    if (node.op === "or") {
      return evaluateNode(node.left, event, payload) || evaluateNode(node.right, event, payload);
    }
  }

  if (node.type === "comparison") {
    const rawVal = readEventFieldValue(event, payload, node.field);
    if (rawVal === undefined || rawVal === null) {
      return false;
    }

    if (node.value.kind === "field") {
      const rightVal = readEventFieldValue(event, payload, node.value.field);
      if (rightVal === undefined || rightVal === null || typeof rawVal !== typeof rightVal) {
        return false;
      }
      return compareSameTypeValues(rawVal, node.op, rightVal);
    }

    const fieldDef = ruleFieldDefForRuntime(node.field, payload);
    return compareValues(rawVal, node.op, node.value, fieldDef);
  }

  return false;
}

function ruleFieldDefForRuntime(
  field: string,
  payload: Record<string, unknown>,
): FieldDefinition | undefined {
  if (BUILTIN_EVENT_FIELDS[field]) return BUILTIN_EVENT_FIELDS[field];
  const eventName = typeof payload.name === "string" ? payload.name : undefined;
  if (eventName && EVENT_PAYLOAD_SCHEMAS[eventName]?.[field]) {
    return EVENT_PAYLOAD_SCHEMAS[eventName]![field];
  }
  return resolveUnscopedFieldDef(field);
}

function compareSameTypeValues(left: unknown, op: ComparisonOp, right: unknown): boolean {
  if (typeof left === "bigint" && typeof right === "bigint") {
    switch (op) {
      case "==":
        return left === right;
      case "!=":
        return left !== right;
      case "<":
        return left < right;
      case "<=":
        return left <= right;
      case ">":
        return left > right;
      case ">=":
        return left >= right;
    }
  }
  if (typeof left === "number" && typeof right === "number") {
    switch (op) {
      case "==":
        return left === right;
      case "!=":
        return left !== right;
      case "<":
        return left < right;
      case "<=":
        return left <= right;
      case ">":
        return left > right;
      case ">=":
        return left >= right;
    }
  }
  if ((typeof left === "string" && typeof right === "string") || (typeof left === "boolean" && typeof right === "boolean")) {
    switch (op) {
      case "==":
        return left === right;
      case "!=":
        return left !== right;
      default:
        return false;
    }
  }
  return false;
}

function compareValues(
  actual: unknown,
  op: ComparisonOp,
  literal: LiteralValue,
  fieldDef?: FieldDefinition,
): boolean {
  const unit = fieldDef ? effectiveUnit(fieldDef) : undefined;

  // BigInt actual value comparison (e.g. stake, amount in DecodedEvent)
  if (typeof actual === "bigint") {
    let targetBigInt: bigint;
    if (literal.kind === "usdc") {
      if (unit && unit !== "usdc_amount") return false;
      targetBigInt = literal.atomic;
    } else if (literal.kind === "number") {
      if (unit === "shares") {
        if (!Number.isInteger(literal.value)) return false;
        targetBigInt = BigInt(literal.value);
      } else if (literal.rawText) {
        targetBigInt = parseUsdcStringToUnits(literal.rawText);
      } else {
        targetBigInt = BigInt(Math.floor(literal.value)) * USDC_SCALE;
      }
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

  // Number actual value comparison (e.g. claimId, marketId, ledger, confidence, side)
  if (typeof actual === "number") {
    let targetNum: number;
    if (literal.kind === "number") {
      targetNum = literal.value;
    } else if (literal.kind === "ledger") {
      if (unit !== "ledger") return false;
      targetNum = literal.value;
    } else if (literal.kind === "identifier") {
      if (unit !== "identifier") return false;
      targetNum = literal.value;
    } else {
      // Never coerce USDC atomic amounts onto numeric identifiers or ledger numbers
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
