/**
 * MarkdownV2 linter and entity tokenizer tests.
 *
 * Verifies that strings exported for Telegram MarkdownV2 parse_mode
 * comply with Telegram's MarkdownV2 syntax:
 *   - 18 reserved characters outside entities must be escaped with '\':
 *     _ * [ ] ( ) ~ ` > # + - = | { } . !
 *   - Entities (*bold*, _italic_, `code`, [text](url)) are understood.
 *   - Placeholders for dynamic interpolation ({var}, {0}, ${var}) are permitted.
 *   - Current i18n MarkdownV2 strings pass without syntax rejections.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  HELP_TITLE,
  NOTIFICATION_MD,
  PAUSE_MESSAGES,
  RESUME_MESSAGES,
  SUPPORTED_LOCALES,
  messagesFor,
} from "../dist/i18n.js";

/** Telegram's MarkdownV2 reserved characters. */
export const MDV2_RESERVED = new Set([
  "_", "*", "[", "]", "(", ")", "~", "`", ">",
  "#", "+", "-", "=", "|", "{", "}", ".", "!",
]);

/** Standard interpolation placeholder patterns (e.g. {var}, {0}, ${var}, {{var}}, %s). */
export const PLACEHOLDER_RE = /^(\$\{[\w.-]+\}|\{\{[\w.-]+\}\}|\{[\w.-]+\}|%[sdifjoOc%])/;

/**
 * Tokenize a MarkdownV2 string into entities, escaped chars, placeholders, and plain text.
 * Flags unescaped reserved characters outside entities as 'reserved' or 'unclosed'.
 *
 * @param {string} text
 * @param {{ allowPlaceholders?: boolean, placeholderRe?: RegExp }} [options]
 * @returns {Array<object>}
 */
export function tokenize(text, options = {}) {
  const allowPlaceholders = options.allowPlaceholders ?? true;
  const placeholderRe = options.placeholderRe ?? PLACEHOLDER_RE;
  const tokens = [];
  let i = 0;
  const len = text.length;

  while (i < len) {
    // 1. Interpolation placeholders (e.g. {var}, {0}, ${var})
    if (allowPlaceholders) {
      const match = text.slice(i).match(placeholderRe);
      if (match) {
        tokens.push({
          type: "placeholder",
          value: match[0],
          start: i,
          end: i + match[0].length,
        });
        i += match[0].length;
        continue;
      }
    }

    // 2. Escaped characters: \ followed by any character (or lone backslash error)
    if (text[i] === "\\") {
      if (i + 1 < len) {
        tokens.push({
          type: "escaped",
          value: text.slice(i, i + 2),
          char: text[i + 1],
          start: i,
          end: i + 2,
        });
        i += 2;
        continue;
      } else {
        tokens.push({
          type: "error",
          value: "\\",
          char: "\\",
          start: i,
          end: i + 1,
          message: `Lone trailing backslash at index ${i}`,
        });
        i += 1;
        continue;
      }
    }

    // 3. Code entity: ```pre``` or `inline code`
    if (text[i] === "`") {
      const isBlock = text.slice(i, i + 3) === "```";
      const delimiter = isBlock ? "```" : "`";
      let j = i + delimiter.length;
      let closed = false;

      while (j < len) {
        if (text[j] === "\\") {
          // Inside code, backslash can escape backtick
          j += (j + 1 < len) ? 2 : 1;
          continue;
        }
        if (text.startsWith(delimiter, j)) {
          closed = true;
          j += delimiter.length;
          break;
        }
        j += 1;
      }

      if (closed) {
        tokens.push({
          type: "code",
          value: text.slice(i, j),
          inner: text.slice(i + delimiter.length, j - delimiter.length),
          block: isBlock,
          start: i,
          end: j,
        });
        i = j;
        continue;
      } else {
        tokens.push({
          type: "unclosed",
          value: delimiter,
          char: "`",
          start: i,
          end: i + delimiter.length,
          message: `Unclosed code entity starting with '${delimiter}' at index ${i}`,
        });
        i += delimiter.length;
        continue;
      }
    }

    // 4. Link entity: [text](url)
    if (text[i] === "[") {
      let j = i + 1;
      let bracketClosed = false;

      while (j < len) {
        if (text[j] === "\\") {
          j += (j + 1 < len) ? 2 : 1;
          continue;
        }
        if (text[j] === "]") {
          bracketClosed = true;
          break;
        }
        j += 1;
      }

      if (bracketClosed && j + 1 < len && text[j + 1] === "(") {
        let k = j + 2;
        let parenClosed = false;
        while (k < len) {
          if (text[k] === "\\") {
            k += (k + 1 < len) ? 2 : 1;
            continue;
          }
          if (text[k] === ")") {
            parenClosed = true;
            break;
          }
          k += 1;
        }

        if (parenClosed) {
          tokens.push({
            type: "link",
            value: text.slice(i, k + 1),
            linkText: text.slice(i + 1, j),
            url: text.slice(j + 2, k),
            start: i,
            end: k + 1,
          });
          i = k + 1;
          continue;
        }
      }

      // If not a valid link entity, '[' is an unescaped reserved character
      tokens.push({
        type: "reserved",
        value: "[",
        char: "[",
        start: i,
        end: i + 1,
        message: `Unescaped reserved character '[' at index ${i}`,
      });
      i += 1;
      continue;
    }

    // 5. Bold entity: *text*
    if (text[i] === "*") {
      let j = i + 1;
      let closed = false;

      while (j < len) {
        if (text[j] === "\\") {
          j += (j + 1 < len) ? 2 : 1;
          continue;
        }
        if (text[j] === "*") {
          closed = true;
          break;
        }
        j += 1;
      }

      if (closed) {
        tokens.push({
          type: "bold",
          value: text.slice(i, j + 1),
          inner: text.slice(i + 1, j),
          start: i,
          end: j + 1,
        });
        i = j + 1;
        continue;
      } else {
        tokens.push({
          type: "unclosed",
          value: "*",
          char: "*",
          start: i,
          end: i + 1,
          message: `Unclosed bold entity '*' at index ${i}`,
        });
        i += 1;
        continue;
      }
    }

    // 6. Italic entity: _text_
    if (text[i] === "_") {
      let j = i + 1;
      let closed = false;

      while (j < len) {
        if (text[j] === "\\") {
          j += (j + 1 < len) ? 2 : 1;
          continue;
        }
        if (text[j] === "_") {
          closed = true;
          break;
        }
        j += 1;
      }

      if (closed) {
        tokens.push({
          type: "italic",
          value: text.slice(i, j + 1),
          inner: text.slice(i + 1, j),
          start: i,
          end: j + 1,
        });
        i = j + 1;
        continue;
      } else {
        tokens.push({
          type: "unclosed",
          value: "_",
          char: "_",
          start: i,
          end: i + 1,
          message: `Unclosed italic entity '_' at index ${i}`,
        });
        i += 1;
        continue;
      }
    }

    // 7. Strikethrough entity: ~text~
    if (text[i] === "~") {
      let j = i + 1;
      let closed = false;

      while (j < len) {
        if (text[j] === "\\") {
          j += (j + 1 < len) ? 2 : 1;
          continue;
        }
        if (text[j] === "~") {
          closed = true;
          break;
        }
        j += 1;
      }

      if (closed) {
        tokens.push({
          type: "strikethrough",
          value: text.slice(i, j + 1),
          inner: text.slice(i + 1, j),
          start: i,
          end: j + 1,
        });
        i = j + 1;
        continue;
      } else {
        tokens.push({
          type: "unclosed",
          value: "~",
          char: "~",
          start: i,
          end: i + 1,
          message: `Unclosed strikethrough entity '~' at index ${i}`,
        });
        i += 1;
        continue;
      }
    }

    // 8. Spoiler entity: ||text||
    if (text.startsWith("||", i)) {
      let j = i + 2;
      let closed = false;

      while (j < len) {
        if (text[j] === "\\") {
          j += (j + 1 < len) ? 2 : 1;
          continue;
        }
        if (text.startsWith("||", j)) {
          closed = true;
          break;
        }
        j += 1;
      }

      if (closed) {
        tokens.push({
          type: "spoiler",
          value: text.slice(i, j + 2),
          inner: text.slice(i + 2, j),
          start: i,
          end: j + 2,
        });
        i = j + 2;
        continue;
      } else {
        tokens.push({
          type: "unclosed",
          value: "||",
          char: "|",
          start: i,
          end: i + 2,
          message: `Unclosed spoiler entity '||' at index ${i}`,
        });
        i += 2;
        continue;
      }
    }

    // 9. Other reserved characters outside entities:
    if (MDV2_RESERVED.has(text[i])) {
      tokens.push({
        type: "reserved",
        value: text[i],
        char: text[i],
        start: i,
        end: i + 1,
        message: `Unescaped reserved character '${text[i]}' at index ${i}`,
      });
      i += 1;
      continue;
    }

    // 10. Normal plain text
    let nextSpecial = i + 1;
    while (
      nextSpecial < len &&
      text[nextSpecial] !== "\\" &&
      !MDV2_RESERVED.has(text[nextSpecial]) &&
      (!allowPlaceholders || !text.slice(nextSpecial).match(placeholderRe))
    ) {
      nextSpecial += 1;
    }

    tokens.push({
      type: "text",
      value: text.slice(i, nextSpecial),
      start: i,
      end: nextSpecial,
    });
    i = nextSpecial;
  }

  return tokens;
}

/**
 * Return all errors (unescaped reserved chars, unclosed entities, lone backslashes)
 * found outside entities.
 *
 * @param {string} text
 * @param {{ allowPlaceholders?: boolean, placeholderRe?: RegExp }} [options]
 * @returns {Array<object>}
 */
export function findUnescapedReserved(text, options = {}) {
  const tokens = tokenize(text, options);
  return tokens.filter(
    (t) => t.type === "reserved" || t.type === "unclosed" || t.type === "error",
  );
}

/**
 * Lint a MarkdownV2 string and return validation status and error messages.
 *
 * @param {string} text
 * @param {{ allowPlaceholders?: boolean, placeholderRe?: RegExp }} [options]
 * @returns {{ valid: boolean, errors: string[], issues: Array<object> }}
 */
export function lintMarkdownV2(text, options = {}) {
  const issues = findUnescapedReserved(text, options);
  return {
    valid: issues.length === 0,
    errors: issues.map((issue) => issue.message),
    issues,
  };
}

/**
 * Assert that text is valid MarkdownV2; throws readable error if violations are found.
 *
 * @param {string} text
 * @param {string} [context]
 * @param {{ allowPlaceholders?: boolean, placeholderRe?: RegExp }} [options]
 */
export function assertValidMarkdownV2(text, context = "", options = {}) {
  const { valid, errors } = lintMarkdownV2(text, options);
  const prefix = context ? `[${context}] ` : "";
  assert.equal(
    valid,
    true,
    `${prefix}Expected valid MarkdownV2, but found errors:\n${errors.join("\n")}\nInput text:\n${text}`,
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// ── Unit Tests: Tokenizer & Linter ──────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════════

test("tokenizer: plain text without reserved characters produces a single text token", () => {
  const tokens = tokenize("Hello world 123");
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].type, "text");
  assert.equal(tokens[0].value, "Hello world 123");
  assert.equal(lintMarkdownV2("Hello world 123").valid, true);
});

test("tokenizer: all 18 reserved characters pass when properly backslash-escaped", () => {
  const allReservedEscaped = "_*[]()~`>#+-=|{}.!".split("").map((c) => `\\${c}`).join(" ");
  assertValidMarkdownV2(allReservedEscaped, "all reserved characters escaped");
});

test("tokenizer: flags unescaped reserved period outside entities", () => {
  const { valid, errors, issues } = lintMarkdownV2("Sentence ending with unescaped.");
  assert.equal(valid, false);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].char, ".");
  assert.match(errors[0], /Unescaped reserved character '\.'/);
});

test("tokenizer: flags unescaped reserved hyphen outside entities", () => {
  const { valid, errors, issues } = lintMarkdownV2("hyphen - unescaped");
  assert.equal(valid, false);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].char, "-");
  assert.match(errors[0], /Unescaped reserved character '-'/);
});

test("tokenizer: flags unescaped exclamation mark outside entities", () => {
  const { valid, errors, issues } = lintMarkdownV2("Attention!");
  assert.equal(valid, false);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].char, "!");
  assert.match(errors[0], /Unescaped reserved character '!'/);
});

test("tokenizer: flags unescaped hash outside entities", () => {
  const { valid, issues } = lintMarkdownV2("Claim #42");
  assert.equal(valid, false);
  assert.equal(issues[0].char, "#");
});

test("tokenizer: flags unescaped plus, equal, pipe, greater-than, and tilde", () => {
  for (const ch of ["+", "=", "|", ">", "~"]) {
    const { valid, issues } = lintMarkdownV2(`Value ${ch} item`);
    assert.equal(valid, false, `Expected '${ch}' to be flagged`);
    assert.equal(issues[0].char, ch);
  }
});

test("tokenizer: flags lone trailing backslash", () => {
  const { valid, errors } = lintMarkdownV2("Trailing \\");
  assert.equal(valid, false);
  assert.match(errors[0], /Lone trailing backslash/);
});

test("tokenizer: understands bold entity (*...*)", () => {
  assertValidMarkdownV2("*Bold headline*");
  assertValidMarkdownV2("Prefix *bold text* suffix");
  assertValidMarkdownV2("*Bold with \\* escaped asterisk inside*");

  // Bold with unescaped period outside
  const { valid, issues } = lintMarkdownV2("*Bold headline*.");
  assert.equal(valid, false);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].char, ".");
});

test("tokenizer: flags unclosed bold entity", () => {
  const { valid, errors } = lintMarkdownV2("*Unclosed bold text");
  assert.equal(valid, false);
  assert.match(errors[0], /Unclosed bold entity/);
});

test("tokenizer: flags stray asterisk", () => {
  const { valid, errors } = lintMarkdownV2("5 * 10 = 50");
  assert.equal(valid, false);
  assert.ok(errors.length >= 2, "Expected both '*' and '=' to be flagged");
});

test("tokenizer: understands italic entity (_..._)", () => {
  assertValidMarkdownV2("_Italic text_");
  assertValidMarkdownV2("Prefix _italic text_ suffix");
  assertValidMarkdownV2("_Italic with \\_ escaped underscore inside_");

  const { valid, errors } = lintMarkdownV2("_Unclosed italic");
  assert.equal(valid, false);
  assert.match(errors[0], /Unclosed italic entity/);
});

test("tokenizer: understands inline code (`...`) and code blocks (```...```)", () => {
  assertValidMarkdownV2("`inline code`");
  assertValidMarkdownV2("`code with dots. and hyphens- and *asterisks*`");
  assertValidMarkdownV2("```\nmulti-line pre. block\n```");
  assertValidMarkdownV2("`code with \\` escaped backtick`");

  const { valid: v1, errors: e1 } = lintMarkdownV2("`unclosed inline code");
  assert.equal(v1, false);
  assert.match(e1[0], /Unclosed code entity/);

  const { valid: v2, errors: e2 } = lintMarkdownV2("```unclosed block");
  assert.equal(v2, false);
  assert.match(e2[0], /Unclosed code entity/);
});

test("tokenizer: understands inline links ([text](url))", () => {
  assertValidMarkdownV2("[Click here](https://example.com/path?foo=1&bar=2-3#hash)");
  assertValidMarkdownV2("[Link with \\] escaped bracket](https://example.com)");
  assertValidMarkdownV2("[Link](https://example.com/path_with_\\)_escaped_paren)");

  const { valid: v1, issues: i1 } = lintMarkdownV2("[Unclosed bracket link(url)");
  assert.equal(v1, false);
  assert.equal(i1[0].char, "[");

  const { valid: v2, issues: i2 } = lintMarkdownV2("[Broken link](unclosed");
  assert.equal(v2, false);
  assert.equal(i2[0].char, "[");
});

test("tokenizer: understands strikethrough (~...~) and spoilers (||...||)", () => {
  assertValidMarkdownV2("~strikethrough text~");
  assertValidMarkdownV2("||spoiler content||");

  const { valid: v1 } = lintMarkdownV2("~unclosed strike");
  assert.equal(v1, false);

  const { valid: v2 } = lintMarkdownV2("||unclosed spoiler");
  assert.equal(v2, false);
});

test("tokenizer: allows interpolation placeholders by default", () => {
  assertValidMarkdownV2("Claim \\#{claimId} created for {creator}");
  assertValidMarkdownV2("Ledger {0} with tx {1}");
  assertValidMarkdownV2("User ${userId} paid %s");
  assertValidMarkdownV2("Balance {{balance}}");

  // When placeholders are disabled, unescaped { and } are flagged
  const { valid, issues } = lintMarkdownV2("Claim {claimId}", { allowPlaceholders: false });
  assert.equal(valid, false);
  assert.ok(issues.some((i) => i.char === "{"));
  assert.ok(issues.some((i) => i.char === "}"));
});

test("tokenizer: flags multiple unescaped reserved characters with accurate positions", () => {
  const { valid, issues } = lintMarkdownV2("Unescaped - dash and . dot and ! bang");
  assert.equal(valid, false);
  assert.equal(issues.length, 3);
  assert.equal(issues[0].char, "-");
  assert.equal(issues[1].char, ".");
  assert.equal(issues[2].char, "!");
});

// ═════════════════════════════════════════════════════════════════════════════
// ── Export Tests: src/i18n.ts MarkdownV2 Exports ─────────────────────────────
// ═════════════════════════════════════════════════════════════════════════════

test("i18n export: HELP_TITLE is valid MarkdownV2", () => {
  assert.equal(typeof HELP_TITLE, "string");
  assertValidMarkdownV2(HELP_TITLE, "HELP_TITLE");
});

test("i18n export: PAUSE_MESSAGES are valid MarkdownV2 strings", () => {
  for (const [key, msg] of Object.entries(PAUSE_MESSAGES)) {
    assert.equal(typeof msg, "string");
    assertValidMarkdownV2(msg, `PAUSE_MESSAGES.${key}`);
  }
});

test("i18n export: RESUME_MESSAGES are valid MarkdownV2 strings", () => {
  for (const [key, msg] of Object.entries(RESUME_MESSAGES)) {
    assert.equal(typeof msg, "string");
    assertValidMarkdownV2(msg, `RESUME_MESSAGES.${key}`);
  }
});

test("i18n export: NOTIFICATION_MD static prefix and preview headers are valid MarkdownV2", () => {
  assertValidMarkdownV2(NOTIFICATION_MD.previewModePrefix, "previewModePrefix");
  assertValidMarkdownV2(NOTIFICATION_MD.channelPreviewMarket, "channelPreviewMarket");
  assertValidMarkdownV2(NOTIFICATION_MD.channelPreviewSquad, "channelPreviewSquad");
});

test("i18n export: NOTIFICATION_MD template functions produce valid MarkdownV2 with placeholders", () => {
  // mimir-market templates
  assertValidMarkdownV2(
    NOTIFICATION_MD.claimCreated("{claimId}", "{category}", "{creator}"),
    "claimCreated",
  );

  assertValidMarkdownV2(
    NOTIFICATION_MD.claimChallenged("{claimId}", "{stake}", "{challenger}"),
    "claimChallenged",
  );

  assertValidMarkdownV2(
    NOTIFICATION_MD.claimResolved("{claimId}", "{winnerSide}", "{confidence}", "{summary}"),
    "claimResolved (with summary)",
  );

  assertValidMarkdownV2(
    NOTIFICATION_MD.claimResolved("{claimId}", "{winnerSide}", "{confidence}", null),
    "claimResolved (null summary)",
  );

  assertValidMarkdownV2(
    NOTIFICATION_MD.claimCancelled("{claimId}"),
    "claimCancelled",
  );

  assertValidMarkdownV2(
    NOTIFICATION_MD.marketSettled("{claimId}", "{totalPaid}", "{totalFees}", "{owedToChallengers}"),
    "marketSettled",
  );

  assertValidMarkdownV2(
    NOTIFICATION_MD.challengerPaid("{claimId}", "{challenger}", "{stake}", "{net}", "{gross}", "{fee}"),
    "challengerPaid",
  );

  assertValidMarkdownV2(
    NOTIFICATION_MD.feeClaimed("{amount}", "{recipient}"),
    "feeClaimed",
  );

  assertValidMarkdownV2(
    NOTIFICATION_MD.withdrawal("{amount}", "{to}"),
    "withdrawal",
  );

  assertValidMarkdownV2(
    NOTIFICATION_MD.withdrawalPending("{amount}", "{to}"),
    "withdrawalPending",
  );

  // mimir-squad templates
  assertValidMarkdownV2(
    NOTIFICATION_MD.marketCreated("{marketId}", "{question}", "{captain}", "{feeBps}", "{deadline}"),
    "marketCreated",
  );

  assertValidMarkdownV2(
    NOTIFICATION_MD.deposited("{marketId}", "{amount}", "{side}", "{participant}"),
    "deposited",
  );

  assertValidMarkdownV2(
    NOTIFICATION_MD.withdrawn("{marketId}", "{participant}", "{amount}", "{side}"),
    "withdrawn",
  );

  assertValidMarkdownV2(
    NOTIFICATION_MD.resolved("{marketId}", "{result}", "{poolA}", "{poolB}"),
    "resolved",
  );

  assertValidMarkdownV2(
    NOTIFICATION_MD.claimed("{marketId}", "{participant}", "{net}", "{gross}", "{fee}"),
    "claimed",
  );

  assertValidMarkdownV2(
    NOTIFICATION_MD.feesClaimedSquad("{amount}", "{recipient}"),
    "feesClaimedSquad",
  );

  // fallback templates
  assertValidMarkdownV2(
    NOTIFICATION_MD.fallbackEvent("{source}", "{contract}", "{ledger}", "{reason}", " · [tx](https://example.com/tx/abc)"),
    "fallbackEvent (with tx link)",
  );

  assertValidMarkdownV2(
    NOTIFICATION_MD.fallbackEvent("{source}", "{contract}", "{ledger}", "{reason}", ""),
    "fallbackEvent (without tx link)",
  );
});

test("i18n export: every locale's MarkdownV2 strings are valid", () => {
  for (const locale of SUPPORTED_LOCALES) {
    const messages = messagesFor(locale);
    assertValidMarkdownV2(messages.helpTitle, `${locale}.helpTitle`);

    for (const [key, value] of Object.entries(messages.pauseMessages)) {
      assertValidMarkdownV2(value, `${locale}.PAUSE_MESSAGES.${key}`);
    }
    for (const [key, value] of Object.entries(messages.resumeMessages)) {
      assertValidMarkdownV2(value, `${locale}.RESUME_MESSAGES.${key}`);
    }

    for (const [key, value] of Object.entries(messages.notificationMd)) {
      if (typeof value === "string") {
        assertValidMarkdownV2(value, `${locale}.NOTIFICATION_MD.${key}`);
      } else if (typeof value === "function") {
        const args = Array.from({ length: value.length }, (_, idx) => `{arg${idx}}`);
        assertValidMarkdownV2(value(...args), `${locale}.NOTIFICATION_MD.${key}`);
      } else {
        assert.fail(`Unexpected entry type for ${locale}.NOTIFICATION_MD.${key}`);
      }
    }
  }
});

test("i18n export: every entry in NOTIFICATION_MD is exhaustively verified", () => {
  for (const [key, value] of Object.entries(NOTIFICATION_MD)) {
    if (typeof value === "string") {
      assertValidMarkdownV2(value, `NOTIFICATION_MD.${key}`);
    } else if (typeof value === "function") {
      // Provide dummy interpolation placeholders matching arity
      const args = Array.from({ length: value.length }, (_, idx) => `{arg${idx}}`);
      const rendered = value(...args);
      assert.equal(typeof rendered, "string", `NOTIFICATION_MD.${key} must return string`);
      assertValidMarkdownV2(rendered, `NOTIFICATION_MD.${key}`);
    } else {
      assert.fail(`Unexpected entry type for NOTIFICATION_MD.${key}: ${typeof value}`);
    }
  }
});
