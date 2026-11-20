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
 */

import type { DecodedEvent } from "../stellar/decode.js";

/** USDC atomic unit divisor (7 decimal places). */
export const USDC_SCALE = 10_000_000n;

/**
 * Expected schema type for fields.
 */
export type FieldType = "string" | "number" | "bigint" | "boolean";

export interface FieldDefinition {
  type: FieldType;
  /** Whether the field is an amount in atomic 7-decimal USDC units. */
  isUsdcAmount?: boolean;
}

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

/** Maximum allowed non-EOF tokens in a single filter expression before parsing. */
export const MAX_FILTER_TOKENS = 100;

/** Maximum allowed nesting depth for parentheses in filter expressions. */
export const MAX_FILTER_DEPTH = 10;

/** 0-based character span [start, end) in the original filter input. */
export interface SourceRange {
  start: number;
  end: number;
}

/** Stable machine-readable error codes for filter expression validation. */
export type FilterErrorCode =
  | "FILTER_SYNTAX_ERROR"
  | "FILTER_UNKNOWN_EVENT"
  | "FILTER_UNKNOWN_FIELD"
  | "FILTER_TYPE_MISMATCH"
  | "FILTER_OPERATOR_NOT_SUPPORTED"
  | "FILTER_USDC_PRECISION"
  | "FILTER_TOKEN_LIMIT"
  | "FILTER_DEPTH_LIMIT";

function boundedTokenLabel(text: string, maxLen = 32): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 1)}…`;
}

/** Error thrown when a filter expression exceeds the maximum allowed token count. */
export class FilterTokenLimitError extends Error {
  public readonly code = "FILTER_TOKEN_LIMIT" as const;
  public readonly count: number;
  public readonly limit: number;
  public readonly range: SourceRange;

  constructor(
    count: number,
    limit: number = MAX_FILTER_TOKENS,
    range: SourceRange = { start: 0, end: 0 },
  ) {
    super(`Filter expression exceeds maximum token limit of ${limit} (got ${count})`);
    this.name = "FilterTokenLimitError";
    this.count = count;
    this.limit = limit;
    this.range = range;
  }
}

/** Error thrown when a filter expression exceeds the maximum allowed nesting depth. */
export class FilterDepthLimitError extends Error {
  public readonly code = "FILTER_DEPTH_LIMIT" as const;
  public readonly depth: number;
  public readonly limit: number;
  public readonly position: number;
  public readonly range: SourceRange;

  constructor(depth: number, limit: number = MAX_FILTER_DEPTH, position = 0) {
    super(`At character ${position}: Filter expression exceeds maximum nesting depth of ${limit} (depth ${depth})`);
    this.name = "FilterDepthLimitError";
    this.depth = depth;
    this.limit = limit;
    this.position = position;
    this.range = { start: position, end: position + 1 };
  }
}

/** Parse / Validation Error with character position, source range, and machine-readable code. */
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
  | { kind: "number"; value: number }
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
export function parseUsdcStringToUnits(numStr: string, pos = 0, end?: number): bigint {
  const parts = numStr.split(".");
  const wholeStr = parts[0] ?? "";
  const fracStr = parts[1] ?? "";

  if (fracStr.length > 7) {
    throw new FilterParseError(
      `USDC amount "${boundedTokenLabel(numStr)}" exceeds maximum precision of 7 decimals`,
      pos,
      end ?? pos + numStr.length,
      "FILTER_USDC_PRECISION",
    );
  }

  const whole = BigInt(wholeStr);
  const frac = BigInt(fracStr.padEnd(7, "0"));
  return whole * USDC_SCALE + frac;
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
  private tokenCount = 0;
  private currentDepth = 0;
  private readonly maxTokens: number;
  private readonly maxDepth: number;

  constructor(input: string, options?: FilterParserOptions) {
    this.maxTokens = options?.maxTokens ?? MAX_FILTER_TOKENS;
    this.maxDepth = options?.maxDepth ?? MAX_FILTER_DEPTH;

    // Bound token count upfront to reject excessive tokens and avoid deep recursion/allocation spikes
    countFilterTokens(input, this.maxTokens);

    this.lexer = new Lexer(input);
    this.currentToken = this.advance();
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
      if (EVENT_PAYLOAD_SCHEMAS && !(eventName in EVENT_PAYLOAD_SCHEMAS)) {
        throw new FilterParseError(
          `Unknown event name "${boundedTokenLabel(eventName)}"`,
          eventNamePos,
          eventNameEnd,
          "FILTER_UNKNOWN_EVENT",
        );
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
      validateConditionAgainstSchema(condition, eventName);
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
      `Expected literal value (string, number, USDC amount, or boolean), got "${boundedTokenLabel(tok.text || "EOF")}"`,
      tok.pos,
      tok.end,
    );
  }
}

/** Validate fields and types in condition against the given event payload schema. */
export function validateConditionAgainstSchema(condition: ExprNode, eventName: string): void {
  const schema = EVENT_PAYLOAD_SCHEMAS[eventName];
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
            `Field "${node.field}" is a numeric/USDC amount, but got ${node.value.kind} literal`,
            node.valuePos,
            node.valueEnd,
            "FILTER_TYPE_MISMATCH",
          );
        }
        break;

      case "number":
        if (node.value.kind !== "number") {
          throw new FilterParseError(
            `Field "${node.field}" is a number, but got ${node.value.kind} literal`,
            node.valuePos,
            node.valueEnd,
            "FILTER_TYPE_MISMATCH",
          );
        }
        break;
    }
  }

  traverse(condition);
}

// ----------------------------------------------------
// Public parse function
// ----------------------------------------------------

/**
 * Parses a filter expression string into a structured {@link FilterRule}.
 * Bounds token count and nesting depth upfront to prevent allocation spikes
 * or deep recursion on hostile input.
 *
 * @param input The raw filter expression string.
 * @param options Optional limits on tokens ({@link MAX_FILTER_TOKENS}) and depth ({@link MAX_FILTER_DEPTH}).
 * @throws {@link FilterTokenLimitError} if token count exceeds maxTokens.
 * @throws {@link FilterDepthLimitError} if parentheses nesting depth exceeds maxDepth.
 * @throws {@link FilterParseError} on invalid syntax, unknown fields, or type mismatches.
 */
export function parseFilterExpression(input: string, options?: FilterParserOptions): FilterRule {
  const parser = new FilterParser(input, options);
  return parser.parseRule(input);
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
