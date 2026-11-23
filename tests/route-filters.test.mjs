import assert from "node:assert/strict";
import test from "node:test";

import {
  CompiledRouteFilterRegistry,
  RouteFilterValidationError,
  compileFilterPolicy,
  compileRouteFilters,
} from "../dist/notifications/route-filters.js";

function mockEvent(source, payload) {
  return {
    source,
    contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    version: "v1",
    ledger: 1000,
    txHash: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    at: 1700000000,
    eventId: "0000001000-0000000001",
    eventType: "contract",
    transactionIndex: 1,
    operationIndex: 1,
    inSuccessfulContractCall: true,
    payload,
  };
}

const smallChallenge = mockEvent("market", {
  name: "claim_challenged",
  claimId: 1,
  challenger: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  stake: 50_000_000n, // 5 USDC
});

const mediumChallenge = mockEvent("market", {
  name: "claim_challenged",
  claimId: 2,
  challenger: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  stake: 250_000_000n, // 25 USDC
});

const largeChallenge = mockEvent("market", {
  name: "claim_challenged",
  claimId: 3,
  challenger: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  stake: 2_000_000_000n, // 200 USDC
});

const smallDeposit = mockEvent("squad", {
  name: "deposited",
  marketId: 10,
  side: 1,
  participant: "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
  amount: 100_000_000n, // 10 USDC
  shares: 100_000_000n,
});

const largeDeposit = mockEvent("squad", {
  name: "deposited",
  marketId: 10,
  side: 1,
  participant: "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
  amount: 1_000_000_000n, // 100 USDC
  shares: 1_000_000_000n,
});

const cryptoClaim = mockEvent("market", {
  name: "claim_created",
  claimId: 4,
  creator: "GDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
  category: "crypto",
  title: "ETH > $5k",
});

const sportsClaim = mockEvent("market", {
  name: "claim_created",
  claimId: 5,
  creator: "GDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
  category: "sports",
  title: "Finals winner",
});

// ----------------------------------------------------
// Global baseline behavior
// ----------------------------------------------------

test("routes without overrides inherit global thresholds and expressions", () => {
  const registry = compileRouteFilters({
    global: {
      thresholds: { marketChallenge: "20", squadDeposit: "50" },
      expressions: [
        "claim_challenged",
        "deposited",
        "claim_created where category == 'crypto'",
      ],
    },
  });

  assert.ok(registry instanceof CompiledRouteFilterRegistry);
  assert.equal(registry.invalidRoutes.size, 0);

  const d1 = registry.evaluate("default-chat", smallChallenge);
  assert.equal(d1.allowed, false);
  assert.equal(d1.reason, "threshold_not_met");
  assert.equal(d1.overrideStatus, "none");
  assert.equal(d1.effectiveMode, "global");

  assert.equal(registry.shouldNotify("default-chat", mediumChallenge), true);
  assert.equal(registry.shouldNotify("default-chat", smallDeposit), false);
  assert.equal(registry.shouldNotify("default-chat", largeDeposit), true);
  assert.equal(registry.shouldNotify("default-chat", cryptoClaim), true);

  const dSports = registry.evaluate("default-chat", sportsClaim);
  assert.equal(dSports.allowed, false);
  assert.equal(dSports.reason, "global_expression_mismatch");
});

// ----------------------------------------------------
// Merge mode precedence (default)
// ----------------------------------------------------

test("merge mode overrides specified threshold fields while inheriting unspecified ones", () => {
  const registry = compileRouteFilters({
    global: {
      thresholds: { marketChallenge: "20", squadDeposit: "50" },
    },
    routes: {
      "whale-chat": {
        thresholds: { marketChallenge: "100" },
      },
      "all-challenges": {
        thresholds: { marketChallenge: "0" }, // explicitly disables global marketChallenge
      },
    },
  });

  // whale-chat raises marketChallenge to 100 USDC, inherits squadDeposit = 50 USDC
  assert.equal(registry.shouldNotify("whale-chat", mediumChallenge), false);
  assert.equal(registry.shouldNotify("whale-chat", largeChallenge), true);
  assert.equal(registry.shouldNotify("whale-chat", smallDeposit), false);
  assert.equal(registry.shouldNotify("whale-chat", largeDeposit), true);

  // all-challenges disables marketChallenge (0), inherits squadDeposit = 50 USDC
  assert.equal(registry.shouldNotify("all-challenges", smallChallenge), true);
  assert.equal(registry.shouldNotify("all-challenges", smallDeposit), false);
  assert.equal(registry.shouldNotify("all-challenges", largeDeposit), true);
});

test("merge mode narrows global expressions with route-specific expressions", () => {
  const registry = compileRouteFilters({
    global: {
      expressions: [
        "claim_created where category == 'crypto'",
        "claim_created where category == 'sports'",
      ],
    },
    routes: {
      "crypto-only": {
        expressions: ["claim_created where category == 'crypto'"],
      },
    },
  });

  // Global allows both crypto and sports
  assert.equal(registry.shouldNotify("general", cryptoClaim), true);
  assert.equal(registry.shouldNotify("general", sportsClaim), true);

  // crypto-only narrows to crypto only
  assert.equal(registry.shouldNotify("crypto-only", cryptoClaim), true);
  const dSports = registry.evaluate("crypto-only", sportsClaim);
  assert.equal(dSports.allowed, false);
  assert.equal(dSports.reason, "route_expression_mismatch");
  assert.equal(dSports.effectiveMode, "merge");

  // An event blocked by global is still blocked in merge mode
  const dChallenge = registry.evaluate("crypto-only", largeChallenge);
  assert.equal(dChallenge.allowed, false);
  assert.equal(dChallenge.reason, "global_expression_mismatch");
});

// ----------------------------------------------------
// Replace mode precedence
// ----------------------------------------------------

test("replace mode completely replaces global thresholds and expressions for that route", () => {
  const registry = compileRouteFilters({
    global: {
      thresholds: { marketChallenge: "100", squadDeposit: "100" },
      expressions: ["claim_created where category == 'crypto'"],
    },
    routes: {
      "firehose": {
        mode: "replace",
        // No thresholds or expressions => allows everything
      },
      "sports-vip": {
        mode: "replace",
        expressions: ["claim_created where category == 'sports'"],
      },
    },
  });

  // Global blocks smallChallenge and sportsClaim
  assert.equal(registry.shouldNotify("default", smallChallenge), false);
  assert.equal(registry.shouldNotify("default", sportsClaim), false);

  // firehose replaces global completely
  const dFirehose = registry.evaluate("firehose", smallChallenge);
  assert.equal(dFirehose.allowed, true);
  assert.equal(dFirehose.effectiveMode, "replace");
  assert.equal(registry.shouldNotify("firehose", sportsClaim), true);

  // sports-vip allows sports even though global only allows crypto, and blocks crypto
  assert.equal(registry.shouldNotify("sports-vip", sportsClaim), true);
  const dCrypto = registry.evaluate("sports-vip", cryptoClaim);
  assert.equal(dCrypto.allowed, false);
  assert.equal(dCrypto.reason, "route_expression_mismatch");
  assert.equal(dCrypto.effectiveMode, "replace");
});

// ----------------------------------------------------
// Route kill switch (enabled: false)
// ----------------------------------------------------

test("enabled: false suppresses all events for the disabled route only", () => {
  const registry = compileRouteFilters({
    global: {},
    routes: {
      "muted-chat": { enabled: false },
      "active-chat": { enabled: true },
    },
  });

  const dMuted = registry.evaluate("muted-chat", cryptoClaim);
  assert.equal(dMuted.allowed, false);
  assert.equal(dMuted.reason, "route_disabled");
  assert.equal(dMuted.overrideStatus, "applied");

  assert.equal(registry.shouldNotify("active-chat", cryptoClaim), true);
  assert.equal(registry.shouldNotify("unlisted-chat", cryptoClaim), true);
});

// ----------------------------------------------------
// Fault isolation for invalid route overrides
// ----------------------------------------------------

test("invalid route override is isolated to the affected route and falls back to global by default", () => {
  const registry = compileRouteFilters({
    global: {
      thresholds: { marketChallenge: "20" },
    },
    routes: {
      "broken-expr": {
        expressions: ["claim_created where nonexistentField == 'x'"],
      },
      "broken-threshold": {
        thresholds: { marketChallenge: "-5" },
      },
      "broken-mode": {
        // @ts-expect-error testing runtime validation
        mode: "invalid_mode",
      },
      "valid-whale": {
        thresholds: { marketChallenge: "100" },
      },
    },
  });

  // All 3 broken routes are recorded in invalidRoutes
  assert.equal(registry.invalidRoutes.size, 3);
  assert.ok(registry.invalidRoutes.has("broken-expr"));
  assert.ok(registry.invalidRoutes.has("broken-threshold"));
  assert.ok(registry.invalidRoutes.has("broken-mode"));
  assert.ok(registry.invalidRoutes.get("broken-expr").issues.length > 0);

  // Valid route is unaffected and applies its 100 USDC override
  assert.equal(registry.routes.has("valid-whale"), true);
  assert.equal(registry.shouldNotify("valid-whale", mediumChallenge), false);
  assert.equal(registry.shouldNotify("valid-whale", largeChallenge), true);

  // Affected routes fall back safely to global (20 USDC threshold)
  const dBrokenSmall = registry.evaluate("broken-expr", smallChallenge);
  assert.equal(dBrokenSmall.allowed, false);
  assert.equal(dBrokenSmall.reason, "threshold_not_met");
  assert.equal(dBrokenSmall.overrideStatus, "invalid_fallback_global");
  assert.equal(dBrokenSmall.effectiveMode, "global");

  const dBrokenMed = registry.evaluate("broken-expr", mediumChallenge);
  assert.equal(dBrokenMed.allowed, true);
  assert.equal(dBrokenMed.overrideStatus, "invalid_fallback_global");
});

test("invalidRouteFallback: 'deny' fails closed for affected routes without impacting other routes", () => {
  const registry = compileRouteFilters(
    {
      global: {},
      routes: {
        "broken-route": {
          expressions: ["not_a_real_event where x == 1"],
        },
        "healthy-route": {
          expressions: ["claim_created where category == 'crypto'"],
        },
      },
    },
    { invalidRouteFallback: "deny" },
  );

  assert.equal(registry.invalidRoutes.size, 1);

  const dBroken = registry.evaluate("broken-route", cryptoClaim);
  assert.equal(dBroken.allowed, false);
  assert.equal(dBroken.reason, "invalid_override_denied");
  assert.equal(dBroken.overrideStatus, "invalid_denied");

  // Healthy route and unlisted route remain unaffected
  assert.equal(registry.shouldNotify("healthy-route", cryptoClaim), true);
  assert.equal(registry.shouldNotify("unlisted-route", cryptoClaim), true);
});

// ----------------------------------------------------
// Boundary & validation error cases
// ----------------------------------------------------

test("invalid global policy throws RouteFilterValidationError with all collected issues", () => {
  assert.throws(
    () =>
      compileRouteFilters({
        global: {
          expressions: ["bad_event", ""],
          thresholds: { marketChallenge: "-10", squadDeposit: "1.12345678" },
        },
      }),
    (err) => {
      assert.ok(err instanceof RouteFilterValidationError);
      assert.equal(err.scope, "global");
      assert.equal(err.issues.length, 4);
      return true;
    },
  );
});

test("compileFilterPolicy supports atomic bigint thresholds and rejects negative bigints", () => {
  const policy = compileFilterPolicy({
    thresholds: { marketChallenge: 50_000_000n, squadDeposit: 0n },
  });
  assert.equal(policy.thresholds.marketChallenge, 50_000_000n);
  assert.equal(policy.thresholds.squadDeposit, 0n);

  assert.throws(
    () => compileFilterPolicy({ thresholds: { marketChallenge: -1n } }),
    RouteFilterValidationError,
  );
});

test("evaluateAll evaluates an event across multiple routes in order", () => {
  const registry = compileRouteFilters({
    global: { thresholds: { marketChallenge: "20" } },
    routes: {
      "whale": { thresholds: { marketChallenge: "100" } },
      "muted": { enabled: false },
      "broken": { thresholds: { marketChallenge: "abc" } },
    },
  });

  const decisions = registry.evaluateAll(
    ["default", "whale", "muted", "broken"],
    mediumChallenge,
  );

  assert.deepEqual(
    decisions.map((d) => ({ routeId: d.routeId, allowed: d.allowed, reason: d.reason })),
    [
      { routeId: "default", allowed: true, reason: "allowed" },
      { routeId: "whale", allowed: false, reason: "threshold_not_met" },
      { routeId: "muted", allowed: false, reason: "route_disabled" },
      { routeId: "broken", allowed: true, reason: "allowed" },
    ],
  );
});
