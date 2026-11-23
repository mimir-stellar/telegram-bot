import assert from "node:assert/strict";
import test from "node:test";

import {
  Logger,
  REDACTED as LINE_REDACTED,
  createLogCapture,
  redactLine,
  renderLogExport,
} from "../dist/logger.js";
import {
  REDACTED,
  clearSecrets,
  redactError,
  redactInlineUrls,
  redactText,
  redactUrl,
  registerSecret,
} from "../dist/redact.js";

const SYNTHETIC_TG_TOK = ["1234567890", "AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"].join(":");
const SYNTHETIC_SEED = ["S", "B".repeat(55)].join("");
const PUBLIC_CONTRACT = "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";
const PUBLIC_ACCOUNT = `G${"C".repeat(55)}`;
const PUBLIC_TX_HASH = "deadbeef".repeat(8);
const SYNTHETIC_JWT = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiJvcGVyYXRvciJ9", "c2lnbmF0dXJlMTIz"].join(".");
const SYNTHETIC_PROVIDER_SEG = "9f8e7d6c5b4a392817263544abcd1234";

function qParam(name, value) {
  return `${name}=${value}`;
}

test.beforeEach(() => {
  clearSecrets();
  Logger.reset();
});

test("repeated credential query parameters are all redacted while safe diagnostics survive", () => {
  const apiKeyName = ["api", "key"].join("_");
  const accessTokName = ["access", "token"].join("_");
  const url =
    `https://rpc.example/v1/soroban?` +
    [
      qParam("token", "first_alpha_111"),
      qParam("limit", "25"),
      qParam("token", "second_beta_222"),
      qParam("token[]", "third_gamma_333"),
      qParam("token[0]", "fourth_delta_444"),
      qParam(apiKeyName, "fifth_eps_555"),
      qParam("cursor", "0018276211125911551-4294967295"),
      qParam(apiKeyName, "sixth_zeta_666"),
      qParam(accessTokName, "seventh_eta_777"),
      qParam("x-api-key", "eighth_theta_888"),
    ].join("&");

  for (const fn of [redactUrl, redactText, (u) => redactError(new Error(u))]) {
    const out = fn(url);
    assert.equal(out.includes("first_alpha_111"), false);
    assert.equal(out.includes("second_beta_222"), false);
    assert.equal(out.includes("third_gamma_333"), false);
    assert.equal(out.includes("fourth_delta_444"), false);
    assert.equal(out.includes("fifth_eps_555"), false);
    assert.equal(out.includes("sixth_zeta_666"), false);
    assert.equal(out.includes("seventh_eta_777"), false);
    assert.equal(out.includes("eighth_theta_888"), false);
    assert.equal(out.includes("https://rpc.example/v1/soroban?"), true);
    assert.equal(out.includes("limit=25"), true);
    assert.equal(out.includes("cursor=0018276211125911551-4294967295"), true);
  }
});

test("repeated semicolon-delimited, empty-first, and percent-encoded query credentials are scrubbed", () => {
  const semiUrl = `https://rpc.example/rpc?${[
    qParam("token", ""),
    qParam("token", "real_secret_after_empty"),
    qParam("order", "asc"),
  ].join(";")}`;

  const semiOut = redactUrl(semiUrl);
  assert.equal(semiOut.includes("real_secret_after_empty"), false);
  assert.equal(semiOut.includes("order=asc"), true);
  assert.equal(semiOut, `https://rpc.example/rpc?token=${REDACTED};token=${REDACTED};order=asc`);

  const arbitraryRepeated =
    `https://rpc.example/events?target=market&target=${SYNTHETIC_SEED}` +
    `&target=${encodeURIComponent(SYNTHETIC_TG_TOK)}&token%3Dencoded_eq_val`;
  const arbOut = redactUrl(arbitraryRepeated);
  assert.equal(arbOut.includes(SYNTHETIC_SEED), false);
  assert.equal(arbOut.includes("AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"), false);
  assert.equal(arbOut.includes("encoded_eq_val"), false);
  assert.equal(arbOut.includes("target=market"), true);
});

test("URL fragments are consistently redacted for OAuth pairs, secret shapes, and bare fragments", () => {
  const accessTokName = ["access", "token"].join("_");
  const refreshTokName = ["refresh", "token"].join("_");

  const oauthFragUrl =
    `https://portal.example/oauth/callback?state=ok#${accessTokName}=frag_secret_1&${refreshTokName}=frag_secret_2`;
  assert.equal(
    redactUrl(oauthFragUrl),
    `https://portal.example/oauth/callback?state=ok#${REDACTED}`,
  );
  assert.equal(redactText(`redirected to ${oauthFragUrl}`).includes("frag_secret_1"), false);
  assert.equal(redactText(`redirected to ${oauthFragUrl}`).includes("frag_secret_2"), false);
  assert.equal(redactText(`redirected to ${oauthFragUrl}`).includes("state=ok"), true);

  const bareFragUrl = "https://rpc.example/v1/soroban#short_frag_secret";
  assert.equal(redactUrl(bareFragUrl), `https://rpc.example/v1/soroban#${REDACTED}`);

  const multiHashUrl = `https://rpc.example/v1#${SYNTHETIC_TG_TOK}#${SYNTHETIC_SEED}`;
  const multiHashOut = redactUrl(multiHashUrl);
  assert.equal(multiHashOut, `https://rpc.example/v1#${REDACTED}`);
  assert.equal(multiHashOut.includes(SYNTHETIC_SEED), false);

  assert.equal(redactUrl("https://rpc.example/v1#"), "https://rpc.example/v1#");
});

test("every URL component scrubs secret-shaped values while preserving safe host and path diagnostics", () => {
  assert.equal(
    redactUrl("https://single_api_credential@soroban-testnet.stellar.org/v1"),
    `https://${REDACTED}@soroban-testnet.stellar.org/v1`,
  );
  assert.equal(
    redactUrl("https://:only_password_here@soroban-testnet.stellar.org/v1"),
    `https://${REDACTED}@soroban-testnet.stellar.org/v1`,
  );
  assert.equal(
    redactUrl("wss://ops@corp.example:p@ssw0rd@rpc.example:8443/ws"),
    `wss://${REDACTED}@rpc.example:8443/ws`,
  );

  assert.equal(
    redactUrl(`https://soroban.quiknode.pro/${SYNTHETIC_PROVIDER_SEG}/v1/rpc`),
    `https://soroban.quiknode.pro/${REDACTED}/v1/rpc`,
  );
  assert.equal(
    redactUrl(`https://api.telegram.org/bot${SYNTHETIC_TG_TOK}/sendMessage`),
    `https://api.telegram.org/${REDACTED}/sendMessage`,
  );
  assert.equal(
    redactUrl(`https://rpc.example/signers/${SYNTHETIC_SEED}/inspect`),
    `https://rpc.example/signers/${REDACTED}/inspect`,
  );
  assert.equal(
    redactUrl(`https://rpc.example/session/${SYNTHETIC_JWT}/refresh`),
    `https://rpc.example/session/${REDACTED}/refresh`,
  );
  assert.equal(
    redactUrl("https://rpc.example/v1;token=matrix_cred_999;version=2/events"),
    `https://rpc.example/v1;token=${REDACTED};version=2/events`,
  );

  const safeExplorer = `https://stellar.expert/explorer/testnet/tx/${PUBLIC_TX_HASH}`;
  assert.equal(redactUrl(safeExplorer), safeExplorer);

  const safeChainPath =
    `https://rpc.example:8000/v1/contracts/${PUBLIC_CONTRACT}/accounts/${PUBLIC_ACCOUNT}/ledgers/4226729`;
  assert.equal(redactUrl(safeChainPath), safeChainPath);

  const safeIpv6 = "http://[::1]:8080/health/live?limit=10";
  assert.equal(redactUrl(safeIpv6), safeIpv6);

  registerSecret("custom-tenant-sec");
  assert.equal(
    redactUrl("https://custom-tenant-sec.rpc.example/v1/soroban"),
    `https://${REDACTED}.rpc.example/v1/soroban`,
  );
});

test("inline URLs inside prose preserve surrounding parentheses and punctuation", () => {
  const prose =
    `[boot] network custom (https://token_user@rpc.example/v1/${SYNTHETIC_PROVIDER_SEG}` +
    `?token=one&limit=5&token=two#frag_secret).`;
  const out = redactText(prose, { maxLen: 500 });
  assert.equal(
    out,
    `[boot] network custom (https://${REDACTED}@rpc.example/v1/${REDACTED}` +
      `?token=${REDACTED}&limit=5&token=${REDACTED}#${REDACTED}).`,
  );
  assert.equal(redactInlineUrls(prose), out);
});

test("Logger (text & json) and LogCapture/renderLogExport redact URL fragments and repeated query params consistently", () => {
  const compositeUrl =
    `https://single_tok@rpc.example/${SYNTHETIC_PROVIDER_SEG}/soroban` +
    `?token=rep_one&limit=10&token=rep_two#frag_oauth_val`;

  const records = [];
  Logger.configure({
    level: "debug",
    format: "json",
    sink: (_level, line) => records.push(line),
  });
  Logger.error("poller", `RPC call failed for ${compositeUrl}`, {
    endpoint: compositeUrl,
    nested: { retryUrl: compositeUrl },
  });

  assert.equal(records.length, 1);
  const rawJson = records[0];
  for (const forbidden of [
    "single_tok",
    SYNTHETIC_PROVIDER_SEG,
    "rep_one",
    "rep_two",
    "frag_oauth_val",
  ]) {
    assert.equal(rawJson.includes(forbidden), false, `JSON log leaked ${forbidden}`);
  }
  const parsed = JSON.parse(rawJson);
  assert.equal(
    parsed.endpoint,
    `https://${REDACTED}@rpc.example/${REDACTED}/soroban?token=${REDACTED}&limit=10&token=${REDACTED}#${REDACTED}`,
  );
  assert.equal(parsed.nested.retryUrl, parsed.endpoint);

  const textLines = [];
  Logger.configure({
    level: "info",
    format: "text",
    sink: (_level, line) => textLines.push(line),
  });
  Logger.warn("poller", `retrying ${compositeUrl}`);
  assert.equal(
    textLines[0],
    `retrying https://${REDACTED}@rpc.example/${REDACTED}/soroban?token=${REDACTED}&limit=10&token=${REDACTED}#${REDACTED}`,
  );

  const lineOut = redactLine(`upstream error (${compositeUrl})`, []);
  assert.equal(
    lineOut,
    `upstream error (https://${LINE_REDACTED}@rpc.example/${LINE_REDACTED}/soroban` +
      `?token=${LINE_REDACTED}&limit=10&token=${LINE_REDACTED}#${LINE_REDACTED})`,
  );

  const capture = createLogCapture(10);
  capture.add("error", redactLine(`poll failed: ${compositeUrl}`, []));
  const exported = renderLogExport(
    {
      version: "0.1.0",
      marketContractId: PUBLIC_CONTRACT,
      squadContractId: PUBLIC_CONTRACT,
      rpcUrl: "https://example.invalid/rpc",
      horizonUrl: "https://example.invalid/horizon",
      networkPassphrase: "Test SDF Network ; September 2015",
      botToken: SYNTHETIC_TG_TOK,
      chatId: "-1001234567890",
      pollIntervalMs: 30_000,
      startLookbackLedgers: 60,
      cursorFile: "/tmp/unused-cursor.json",
      maxNotificationsPerCycle: 20,
      healthHost: "127.0.0.1",
      healthPort: 0,
      healthStaleMs: 90_000,
      logBufferLines: 10,
    },
    {
      running: true,
      startedAt: 1_000,
      cycles: 1,
      lastPollAt: 2_000,
      lastSuccessAt: 2_000,
      latestLedger: 10,
      oldestLedger: 1,
      notificationsSent: 0,
      notificationsFailed: 0,
      eventsSkipped: 0,
      consecutiveFailures: 1,
      lastError: { at: 2_000, message: `lastErr ${compositeUrl}` },
      targets: [],
    },
    capture,
    3_000,
  );
  for (const forbidden of [
    "single_tok",
    SYNTHETIC_PROVIDER_SEG,
    "rep_one",
    "rep_two",
    "frag_oauth_val",
    SYNTHETIC_TG_TOK,
  ]) {
    assert.equal(exported.includes(forbidden), false, `export leaked ${forbidden}`);
  }
  assert.equal(exported.includes("limit=10"), true);
});
