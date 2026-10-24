/**
 * Locale-selection tests for src/i18n.ts and the MIMIR_LOCALE config wiring.
 *
 * English strings stay covered by tests/i18n.test.mjs; this file covers the
 * catalog registry, normalization, the Spanish translation, and the fail-fast
 * config path.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_LOCALE,
  EN_MESSAGES,
  ES_MESSAGES,
  LOCALE_LABELS,
  MESSAGES,
  SUPPORTED_LOCALES,
  messagesFor,
  normalizeLocale,
} from "../dist/i18n.js";

import {
  ConfigError,
  configProvenance,
  loadConfig,
} from "../dist/config.js";

const VALID_CONTRACT_A = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const VALID_CONTRACT_B = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBQMF4";

function withEnv(vars, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function validBotEnv(overrides = {}) {
  return {
    BOT_TOKEN: "123456789:" + "A".repeat(40),
    TELEGRAM_CHAT_ID: "-1001234567890",
    MARKET_CONTRACT_ID: VALID_CONTRACT_A,
    SQUAD_CONTRACT_ID: VALID_CONTRACT_B,
    MIMIR_PROFILE: undefined,
    MIMIR_LOCALE: undefined,
    POLL_INTERVAL_MS: undefined,
    STELLAR_RPC_URL: undefined,
    STELLAR_HORIZON_URL: undefined,
    STELLAR_NETWORK_PASSPHRASE: undefined,
    ...overrides,
  };
}

function shapeOf(value) {
  if (Array.isArray(value)) return value.map(shapeOf);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, shapeOf(value[key])]),
    );
  }
  return typeof value;
}

// ── Registry ─────────────────────────────────────────────────────────────────

test("every supported locale has a catalog and a label", () => {
  for (const locale of SUPPORTED_LOCALES) {
    assert.ok(MESSAGES[locale], `missing catalog for ${locale}`);
    assert.equal(typeof LOCALE_LABELS[locale], "string");
    assert.ok(LOCALE_LABELS[locale].length > 0);
  }
  assert.equal(Object.keys(MESSAGES).length, SUPPORTED_LOCALES.length);
});

test("every locale catalog has the same shape as English", () => {
  for (const locale of SUPPORTED_LOCALES) {
    assert.deepEqual(
      shapeOf(MESSAGES[locale]),
      shapeOf(EN_MESSAGES),
      `catalog ${locale} does not match the English catalog shape`,
    );
  }
  assert.deepEqual(Object.keys(MESSAGES.es.commandDescriptions), Object.keys(EN_MESSAGES.commandDescriptions));
});

test("DEFAULT_LOCALE is supported and messagesFor() returns it", () => {
  assert.ok(SUPPORTED_LOCALES.includes(DEFAULT_LOCALE));
  assert.equal(messagesFor(), EN_MESSAGES);
  assert.equal(messagesFor(null), EN_MESSAGES);
  assert.equal(messagesFor("en"), EN_MESSAGES);
});

// ── Normalization ────────────────────────────────────────────────────────────

test("normalizeLocale accepts case and region variants", () => {
  assert.equal(normalizeLocale("es"), "es");
  assert.equal(normalizeLocale("ES"), "es");
  assert.equal(normalizeLocale(" es-MX "), "es");
  assert.equal(normalizeLocale("en_GB"), "en");
  assert.equal(normalizeLocale("en"), "en");
});

test("normalizeLocale rejects unsupported languages and garbage", () => {
  for (const value of ["fr", "de-DE", "", "   ", "english", "e", "es-"]) {
    const result = normalizeLocale(value);
    if (value === "es-") assert.equal(result, "es");
    else assert.equal(result, null, `expected null for ${JSON.stringify(value)}`);
  }
});

test("messagesFor falls back to English for unsupported tags", () => {
  assert.equal(messagesFor("fr"), EN_MESSAGES);
  assert.equal(messagesFor("klingon"), EN_MESSAGES);
  assert.equal(messagesFor("es-MX"), ES_MESSAGES);
});

// ── Spanish catalog ──────────────────────────────────────────────────────────

test("Spanish catalog is a real translation, not English copy", () => {
  assert.notEqual(ES_MESSAGES.helpTitle, EN_MESSAGES.helpTitle);
  assert.notEqual(ES_MESSAGES.helpIntro, EN_MESSAGES.helpIntro);
  assert.notEqual(ES_MESSAGES.auditCliHint, EN_MESSAGES.auditCliHint);
  assert.notEqual(ES_MESSAGES.explorerButtonText, EN_MESSAGES.explorerButtonText);
  assert.notEqual(ES_MESSAGES.notificationMd.claimCreated("7", "crypto", "`G`"), EN_MESSAGES.notificationMd.claimCreated("7", "crypto", "`G`"));

  for (const [command, description] of Object.entries(ES_MESSAGES.commandDescriptions)) {
    assert.ok(description.length > 0, `empty Spanish description for ${command}`);
  }
});

test("Spanish MarkdownV2 notifications render the expected template", () => {
  const md = ES_MESSAGES.notificationMd;
  assert.equal(
    md.claimCreated("7", "crypto", "`GABCD`"),
    "🆕 *Nueva reclamación* \\#7\nCategoría: crypto\nCreador: `GABCD`",
  );
  assert.match(md.claimResolved("7", "challengers", "100", null), /Reclamación \\#7 resuelta/);
  assert.match(md.claimed("3", "`G`", "9", "10", "1"), /Pago de escuadrón/);
  assert.match(md.fallbackEvent("market", "C", "42", "oops", ""), /Motivo: _oops_/);
});

test("Spanish plain-text templates contain no Markdown syntax", () => {
  const plain = ES_MESSAGES.notificationPlain;
  const rendered = [
    plain.claimCreated(1, "cat", "ADDR"),
    plain.claimChallenged(1, "1.0 USDC", "ADDR"),
    plain.claimResolved(1, "claimant", "100", null),
    plain.marketSettled(1, "10.0 USDC", "0.5 USDC", "5.0 USDC"),
    plain.challengerPaid(1, "ADDR", "2.0 USDC", "1.5 USDC", "2.0 USDC", "0.5 USDC"),
    plain.feeClaimed("1.0 USDC", "ADDR"),
    plain.withdrawal("5.0 USDC", "ADDR"),
    plain.withdrawalPending("5.0 USDC", "ADDR"),
    plain.marketCreated(1, "Will it?", "ADDR", "50", "2027-01-01T00:00:00.000Z"),
    plain.deposited(1, "10.0 USDC", "side A", "ADDR"),
    plain.withdrawn(1, "ADDR", "5.0 USDC", "side A"),
    plain.resolved(1, "side A", "10.0 USDC", "5.0 USDC"),
    plain.claimed(1, "ADDR", "9.0 USDC", "10.0 USDC", "1.0 USDC"),
    plain.feesClaimedSquad("2.0 USDC", "ADDR"),
    plain.minimal("market", "ledger 42", "42-0"),
  ];
  for (const text of rendered) {
    assert.equal(/[*_`[\]\\]/.test(text), false, `Markdown syntax in: ${text}`);
  }
});

// ── Config wiring ────────────────────────────────────────────────────────────

test("loadConfig defaults MIMIR_LOCALE to en", () => {
  withEnv(validBotEnv(), () => {
    assert.equal(loadConfig().locale, "en");
  });
});

test("loadConfig reads MIMIR_LOCALE and normalizes region tags", () => {
  withEnv(validBotEnv({ MIMIR_LOCALE: "es" }), () => {
    assert.equal(loadConfig().locale, "es");
  });
  withEnv(validBotEnv({ MIMIR_LOCALE: "es-MX" }), () => {
    assert.equal(loadConfig().locale, "es");
  });
});

test("loadConfig rejects an unsupported MIMIR_LOCALE with the accepted list", () => {
  withEnv(validBotEnv({ MIMIR_LOCALE: "fr" }), () => {
    assert.throws(
      () => loadConfig(),
      (err) => {
        assert.ok(err instanceof ConfigError);
        assert.ok(err.problems.some((p) => p.includes("MIMIR_LOCALE")));
        assert.ok(err.problems.some((p) => p.includes("en, es")));
        return true;
      },
    );
  });
});

test("config provenance reports MIMIR_LOCALE", () => {
  withEnv(validBotEnv({ MIMIR_LOCALE: "es" }), () => {
    const provenance = configProvenance();
    const entry = provenance.entries.find((e) => e.key === "MIMIR_LOCALE");
    assert.ok(entry, "MIMIR_LOCALE missing from provenance");
    assert.equal(entry.secret, false);
    assert.equal(entry.source, "process-env");
  });
});
