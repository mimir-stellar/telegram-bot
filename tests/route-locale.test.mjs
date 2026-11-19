import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_LOCALE } from "../dist/i18n.js";
import {
  explorerKeyboard,
  formatEvent,
  formatFallbackEvent,
  formatPlainTextEvent,
  resolveNotificationLocale,
} from "../dist/notifications/format.js";
import { formatEventHtml, formatFallbackEventHtml } from "../dist/notifications/html.js";

const VALID_TX = "0123456789abcdef".repeat(4);

function baseConfig(overrides = {}) {
  return {
    locale: "en",
    chatId: "-1001000000001",
    marketChatId: "-1001000000001",
    squadChatId: "-1001000000002",
    marketContractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
    squadContractId: "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBQMF4",
    marketContractVersion: "v1",
    squadContractVersion: "v1",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer",
    ...overrides,
  };
}

const MARKET_EVENT = {
  source: "market",
  contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
  version: "v1",
  ledger: 12345,
  txHash: VALID_TX,
  at: 1700000000,
  eventId: "12345-1",
  eventType: "contract",
  payload: {
    name: "claim_created",
    claimId: 42n,
    category: "crypto",
    creator: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  },
};

const SQUAD_EVENT = {
  source: "squad",
  contractId: "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBQMF4",
  version: "v1",
  ledger: 12346,
  txHash: VALID_TX,
  at: 1700000010,
  eventId: "12346-1",
  eventType: "contract",
  payload: {
    name: "deposited",
    marketId: 7n,
    amount: 25_000_000n,
    side: 0,
    participant: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  },
};

// ── resolveNotificationLocale ────────────────────────────────────────────────

test("resolveNotificationLocale selects per-route locale by contract destination chat", () => {
  const config = baseConfig({
    locale: "en",
    routes: [
      { chatId: "-1001000000001", channelPreviewMode: false, locale: "en" },
      { chatId: "-1001000000002", channelPreviewMode: false, locale: "es-MX" },
    ],
  });

  assert.equal(resolveNotificationLocale(config, { source: "market" }), "en");
  assert.equal(resolveNotificationLocale(config, { source: "squad" }), "es");
});

test("resolveNotificationLocale falls back deterministically when route locale is unsupported or blank", () => {
  const configWithEsGlobal = baseConfig({
    locale: "es",
    routes: [
      { chatId: "-1001000000001", channelPreviewMode: false, locale: "fr-CA" },
      { chatId: "-1001000000002", channelPreviewMode: false, locale: "   " },
    ],
  });

  assert.equal(resolveNotificationLocale(configWithEsGlobal, { source: "market" }), "es");
  assert.equal(resolveNotificationLocale(configWithEsGlobal, { source: "squad" }), "es");

  const configWithUnsupportedGlobal = baseConfig({
    locale: "de",
    routes: [{ chatId: "-1001000000001", channelPreviewMode: false, locale: "ja" }],
  });

  assert.equal(resolveNotificationLocale(configWithUnsupportedGlobal, { source: "market" }), DEFAULT_LOCALE);
});

test("resolveNotificationLocale supports explicit route/locale overrides and preserves compatibility without routes", () => {
  const config = baseConfig({ locale: "en" });
  assert.equal(resolveNotificationLocale(config, { source: "market" }), "en");
  assert.equal(resolveNotificationLocale(config, { locale: "es" }), "es");
  assert.equal(resolveNotificationLocale(config, { route: { locale: "es-AR" } }), "es");
  assert.equal(resolveNotificationLocale({ ...config, routeLocale: "es" }), "es");
});

// ── Markdown, Plaintext, HTML, and Keyboard renderers ───────────────────────

test("Markdown, plaintext, HTML, and keyboard renderers honor per-route language preference", () => {
  const config = baseConfig({
    locale: "en",
    routes: [
      { chatId: "-1001000000001", channelPreviewMode: false, locale: "en" },
      { chatId: "-1001000000002", channelPreviewMode: false, locale: "es" },
    ],
  });

  // Market route -> English
  const marketMd = formatEvent(config, MARKET_EVENT);
  const marketPlain = formatPlainTextEvent(config, MARKET_EVENT);
  const marketHtml = formatEventHtml(config, MARKET_EVENT);
  const marketKb = explorerKeyboard(config, MARKET_EVENT);

  assert.match(marketMd, /New claim/);
  assert.match(marketPlain, /New claim/);
  assert.match(marketHtml, /<b>New claim<\/b>/);
  assert.equal(marketKb?.inline_keyboard[0][0].text, "View on Explorer");

  // Squad route -> Spanish
  const squadMd = formatEvent(config, SQUAD_EVENT);
  const squadPlain = formatPlainTextEvent(config, SQUAD_EVENT);
  const squadHtml = formatEventHtml(config, SQUAD_EVENT);
  const squadKb = explorerKeyboard(config, SQUAD_EVENT);

  assert.match(squadMd, /Escuadrón/);
  assert.match(squadMd, /Participante:/);
  assert.match(squadPlain, /Escuadrón/);
  assert.match(squadPlain, /Participante:/);
  assert.match(squadHtml, /<b>Escuadrón #7<\/b>/);
  assert.match(squadHtml, /Participante:/);
  assert.equal(squadKb?.inline_keyboard[0][0].text, "Ver en el explorador");
});

test("unsupported route locale falls back deterministically across Markdown, plaintext, and HTML", () => {
  const config = baseConfig({
    locale: "es",
    routes: [
      { chatId: "-1001000000001", channelPreviewMode: false, locale: "pt-BR" },
    ],
  });

  const md = formatEvent(config, MARKET_EVENT);
  const plain = formatPlainTextEvent(config, MARKET_EVENT);
  const html = formatEventHtml(config, MARKET_EVENT);

  // Falls back to global config.locale ("es")
  assert.match(md, /Nueva reclamación/);
  assert.match(plain, /Nueva reclamación/);
  assert.match(html, /<b>Nueva reclamación<\/b>/);

  // When both route and global locale are unsupported, falls back to English ("en")
  const unsupportedAll = baseConfig({
    locale: "zz",
    routes: [
      { chatId: "-1001000000001", channelPreviewMode: false, locale: "xx" },
    ],
  });

  assert.match(formatEvent(unsupportedAll, MARKET_EVENT), /New claim/);
  assert.match(formatPlainTextEvent(unsupportedAll, MARKET_EVENT), /New claim/);
  assert.match(formatEventHtml(unsupportedAll, MARKET_EVENT), /<b>New claim<\/b>/);
});

test("HTML preview mode and fallback formatters honor per-route locale", () => {
  const config = baseConfig({
    locale: "en",
    channelPreviewMode: true,
    routes: [
      { chatId: "-1001000000001", channelPreviewMode: true, locale: "es" },
    ],
  });

  const previewHtml = formatEventHtml(config, MARKET_EVENT);
  assert.match(previewHtml, /<b>\[MODO VISTA PREVIA\]<\/b>/);
  assert.match(previewHtml, /<b>Nueva reclamación<\/b>/);

  const fallbackHtml = formatFallbackEventHtml(config, MARKET_EVENT, "bad payload");
  assert.match(fallbackHtml, /<b>Notificación de evento alternativa<\/b>/);
  assert.match(fallbackHtml, /Motivo: <i>bad payload<\/i>/);

  const fallbackMd = formatFallbackEvent(config, MARKET_EVENT, "bad payload");
  assert.match(fallbackMd, /Notificación de evento alternativa/);
});
