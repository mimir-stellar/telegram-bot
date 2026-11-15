import assert from "node:assert/strict";
import test from "node:test";

import {
  appUrlFor,
  validateSafeHttpsBaseUrl,
} from "../dist/notifications/app-links.js";
import { eventExplorerUrl } from "../dist/notifications/format.js";
import {
  buildAtomEntry,
  buildAtomFeed,
  FeedBaseUrlError,
  safeHttpsUrl,
  validateFeedBaseUrls,
} from "../dist/stellar/feed.js";

const VALID_TX = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
const VALID_MARKET = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB";
const VALID_SQUAD = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC";

const BASE_CONFIG = {
  marketContractId: VALID_MARKET,
  squadContractId: VALID_SQUAD,
  rpcUrl: "https://soroban-testnet.stellar.org",
  horizonUrl: "https://horizon-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  explorerBaseUrl: "https://stellar.expert/explorer",
  marketContractVersion: "v1",
  squadContractVersion: "v1",
};

function makeClaimEvent(claimId = 7) {
  return {
    source: "market",
    contractId: VALID_MARKET,
    version: "v1",
    ledger: 2500,
    txHash: VALID_TX,
    at: 1_700_000_000,
    eventId: "2500-0",
    eventType: "contract",
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    payload: {
      name: "claim_created",
      claimId,
      category: "crypto",
      creator: "GBMGZ3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    },
  };
}

function makeSquadEvent(marketId = 3) {
  return {
    source: "squad",
    contractId: VALID_SQUAD,
    version: "v1",
    ledger: 2501,
    txHash: VALID_TX,
    at: 1_700_000_060,
    eventId: "2501-0",
    eventType: "contract",
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    payload: {
      name: "market_created",
      marketId,
      creator: "GBMGZ3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
      question: "Will Stellar ship it?",
      deadline: 1_700_050_000,
    },
  };
}

test("validateSafeHttpsBaseUrl and safeHttpsUrl reject userinfo, non-HTTPS schemes, and malformed hosts", () => {
  const credentialUrls = [
    "https://user:supersecret@app.mimir.example",
    "https://user@app.mimir.example/feed.atom",
    "https://:supersecret@app.mimir.example/feed.atom",
    "https://@app.mimir.example/feed.atom",
    "https://:@app.mimir.example/feed.atom",
    "https://trusted.example@attacker.example/feed.atom",
  ];

  for (const url of credentialUrls) {
    const check = validateSafeHttpsBaseUrl(url);
    assert.equal(check.ok, false, `expected ${url} to fail validation`);
    assert.equal(check.reason, "userinfo_present");
    assert.equal(safeHttpsUrl(url), null);
    assert.equal(appUrlFor(makeClaimEvent(), url), null);
  }

  const badHostOrSchemeUrls = [
    "http://app.mimir.example",
    "ftp://app.mimir.example",
    "javascript:alert(1)",
    "https:///path-only",
    "https://\\attacker.example/feed",
    "https://trusted.example\\attacker.example/feed",
    "https://example..com/feed",
    "https://.example.com/feed",
    "https://example.com./feed",
    "https://2130706433/feed",
    "https://app.mimir.example/feed\x00",
  ];

  for (const url of badHostOrSchemeUrls) {
    const check = validateSafeHttpsBaseUrl(url);
    assert.equal(check.ok, false, `expected ${url} to fail validation`);
    assert.equal(safeHttpsUrl(url), null);
    assert.equal(appUrlFor(makeClaimEvent(), url), null);
  }
});

test("buildAtomFeed rejects credential-bearing selfUrl, explorerBaseUrl, and mimirAppUrl before rendering without leaking secrets", () => {
  const events = [makeClaimEvent()];

  assert.throws(
    () =>
      buildAtomFeed(events, {
        title: "Mimir Events",
        selfUrl: "https://admin:mySecretPass123@example.com/feed.atom",
        config: BASE_CONFIG,
      }),
    (err) => {
      assert.ok(err instanceof FeedBaseUrlError);
      assert.equal(err.field, "selfUrl");
      assert.equal(err.reason, "userinfo_present");
      assert.ok(!err.message.includes("mySecretPass123"), "error must never echo secret credentials");
      return true;
    },
  );

  assert.throws(
    () =>
      buildAtomFeed(events, {
        title: "Mimir Events",
        selfUrl: "https://example.com/feed.atom",
        config: {
          ...BASE_CONFIG,
          explorerBaseUrl: "https://token999@stellar.expert/explorer",
        },
      }),
    (err) => {
      assert.ok(err instanceof FeedBaseUrlError);
      assert.equal(err.field, "config.explorerBaseUrl");
      assert.equal(err.reason, "userinfo_present");
      assert.ok(!err.message.includes("token999"));
      return true;
    },
  );

  assert.throws(
    () =>
      validateFeedBaseUrls({
        title: "Mimir Events",
        selfUrl: "https://example.com/feed.atom",
        config: BASE_CONFIG,
        mimirAppUrl: "https://user:secretToken@app.mimir.example",
      }),
    (err) => {
      assert.ok(err instanceof FeedBaseUrlError);
      assert.equal(err.field, "mimirAppUrl");
      assert.equal(err.reason, "userinfo_present");
      assert.ok(!err.message.includes("secretToken"));
      return true;
    },
  );

  // Direct buildAtomEntry and eventExplorerUrl also drop credential-bearing base URLs
  const credConfig = {
    ...BASE_CONFIG,
    explorerBaseUrl: "https://user:pass@stellar.expert/explorer",
  };
  assert.equal(eventExplorerUrl(credConfig, makeClaimEvent()), null);
  const directEntry = buildAtomEntry(
    makeClaimEvent(),
    credConfig,
    "https://user:pass@app.mimir.example",
  );
  assert.equal(directEntry.link, null);
  assert.equal(directEntry.appLink, undefined);
});

test("safe HTTPS app and explorer links are retained across appUrlFor, buildAtomEntry, and buildAtomFeed", () => {
  const claim = makeClaimEvent(7);
  const squad = makeSquadEvent(3);

  assert.equal(
    appUrlFor(claim, "https://app.mimir.example/"),
    "https://app.mimir.example/claims/7",
  );
  assert.equal(
    appUrlFor(squad, "https://app.mimir.example:8443/portal/"),
    "https://app.mimir.example:8443/portal/squads/3",
  );
  assert.equal(
    appUrlFor(claim, "https://[2001:db8::1]:8443"),
    "https://[2001:db8::1]:8443/claims/7",
  );

  const xml = buildAtomFeed([claim, squad], {
    title: "Mimir Events",
    selfUrl: "https://feeds.mimir.example/feed.atom",
    config: BASE_CONFIG,
    mimirAppUrl: "https://app.mimir.example",
    updatedAt: "2026-11-15T12:00:00.000Z",
  });

  assert.ok(xml.includes("<id>https://feeds.mimir.example/feed.atom</id>"));
  assert.ok(xml.includes('href="https://feeds.mimir.example/feed.atom"'));
  assert.ok(xml.includes(`href="https://stellar.expert/explorer/testnet/tx/${VALID_TX}"`));
  assert.ok(xml.includes('href="https://app.mimir.example/claims/7"'));
  assert.ok(xml.includes('href="https://app.mimir.example/squads/3"'));
});
