import assert from "node:assert/strict";
import test from "node:test";

import { compareEndpoints, DIFF_LIST_MAX, formatCompareResult } from "../dist/rpc-compare-cli.js";
import { startMockRpc } from "../dist/stellar/mock-rpc.js";
import { MOCK_MARKET_CONTRACT_ID } from "../dist/stellar/mock-constants.js";

const CONTRACT = MOCK_MARKET_CONTRACT_ID;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function marketEvent(ledger, eventName, fields = {}) {
  return {
    source: "market",
    ledger,
    eventName,
    topics: [ledger],
    fields,
  };
}

function scenario(events, overrides = {}) {
  return {
    latestLedger: 1000,
    oldestLedger: 900,
    ledgersPerPage: 50,
    events,
    ...overrides,
  };
}

async function withTwoMocks(scenA, scenB, fn) {
  const mockA = await startMockRpc({ port: 0, scenario: scenA });
  const mockB = await startMockRpc({ port: 0, scenario: scenB });
  try {
    return await fn(mockA.url, mockB.url);
  } finally {
    await Promise.all([mockA.close(), mockB.close()]);
  }
}

function baseOptions(urlA, urlB, overrides = {}) {
  return {
    rpcA: urlA,
    rpcB: urlB,
    contractId: CONTRACT,
    fromLedger: 900,
    toLedger: 1000,
    pages: 5,
    budget: 40,
    ...overrides,
  };
}

test("rpc-compare: identical scenarios exit 0 with no diffs", async () => {
  const shared = scenario([
    marketEvent(990, "claim_created", { category: "crypto" }),
    marketEvent(992, "claim_challenged", { stake: 20_000_000n }),
    marketEvent(996, "claim_resolved", { winner_side: 2 }),
  ]);

  await withTwoMocks(shared, shared, async (urlA, urlB) => {
    const result = await compareEndpoints(baseOptions(urlA, urlB));
    assert.equal(result.exitCode, 0);
    assert.equal(result.diffCount, 0);
    assert.equal(result.eventsA, result.eventsB);
    assert.equal(result.error, undefined);
    const text = formatCompareResult(result);
    assert.ok(text.includes("Identical:"));
  });
});

test("rpc-compare: redacts URL credentials before any operator-facing output", async () => {
  const mock = await startMockRpc({ port: 0, scenario: scenario([marketEvent(990, "claim_created", {})]) });
  try {
    // A credential-bearing URL: the client may refuse to connect, but the URL
    // must already be redacted in the result object before any fetch happens.
    const credUrl = mock.url.replace("http://127.0.0.1:", "http://operator:secret-pw@127.0.0.1:");
    const result = await compareEndpoints(baseOptions(credUrl, mock.url));
    assert.ok(!result.rpcA.includes("secret-pw"), "rpcA must be redacted");
    assert.ok(result.rpcA.includes("127.0.0.1"), "host must remain readable");
    if (result.error) {
      assert.ok(!result.error.includes("secret-pw"), "error text must not leak the secret");
    }
    const text = formatCompareResult(result);
    assert.ok(!text.includes("secret-pw"), "formatted output must not leak the secret");
  } finally {
    await mock.close();
  }
});

test("rpc-compare: extra event in B exits 1", async () => {
  const scenA = scenario([marketEvent(990, "claim_created", { category: "crypto" })]);
  const scenB = scenario([
    marketEvent(990, "claim_created", { category: "crypto" }),
    marketEvent(991, "claim_challenged", { stake: 5n }),
  ]);

  await withTwoMocks(scenA, scenB, async (urlA, urlB) => {
    const result = await compareEndpoints(baseOptions(urlA, urlB));
    assert.equal(result.exitCode, 1);
    assert.equal(result.diffCount, 1);
    assert.equal(result.diffs[0].status, "extra");
    assert.equal(result.diffs[0].ledger, 991);
  });
});

test("rpc-compare: missing event in B exits 1", async () => {
  const scenA = scenario([
    marketEvent(990, "claim_created", { category: "crypto" }),
    marketEvent(991, "claim_challenged", { stake: 5n }),
  ]);
  const scenB = scenario([marketEvent(990, "claim_created", { category: "crypto" })]);

  await withTwoMocks(scenA, scenB, async (urlA, urlB) => {
    const result = await compareEndpoints(baseOptions(urlA, urlB));
    assert.equal(result.exitCode, 1);
    assert.equal(result.diffCount, 1);
    assert.equal(result.diffs[0].status, "missing");
    assert.equal(result.diffs[0].ledger, 991);
  });
});

test("rpc-compare: differing payload exits 1", async () => {
  const scenA = scenario([marketEvent(990, "claim_created", { category: "crypto" })]);
  const scenB = scenario([marketEvent(990, "claim_created", { category: "other" })]);

  await withTwoMocks(scenA, scenB, async (urlA, urlB) => {
    const result = await compareEndpoints(baseOptions(urlA, urlB));
    assert.equal(result.exitCode, 1);
    assert.equal(result.diffCount, 1);
    const d = result.diffs[0];
    assert.equal(d.status, "differing");
    assert.equal(d.ledger, 990);
    assert.ok(d.fields && d.fields.length > 0, "expected field-level diffs");
    assert.ok(d.fields.some((f) => f.field === "value"), "value field should differ");
  });
});

test("rpc-compare: endpoint error exits 2", async () => {
  const scenA = scenario([marketEvent(990, "claim_created", { category: "crypto" })]);
  const mockA = await startMockRpc({ port: 0, scenario: scenA });
  const mockB = await startMockRpc({
    port: 0,
    scenario: scenA,
    failures: { getHealth: { kind: "error", times: 1 } },
  });
  try {
    const result = await compareEndpoints(baseOptions(mockA.url, mockB.url));
    assert.equal(result.exitCode, 2);
    assert.ok(result.error, "expected an error message");
  } finally {
    await Promise.all([mockA.close(), mockB.close()]);
  }
});

test("rpc-compare: respects page budget", async () => {
  const shared = scenario([marketEvent(990, "claim_created", { category: "crypto" })]);

  await withTwoMocks(shared, shared, async (urlA, urlB) => {
    // budget 2 => one page per endpoint max.
    const result = await compareEndpoints(baseOptions(urlA, urlB, { budget: 2 }));
    assert.ok(result.exitCode === 0 || result.exitCode === 1);
    assert.ok(result.pagesA <= 1 && result.pagesB <= 1, "pages must respect budget");
  });
});

test("rpc-compare: invalid inputs exit 2", async () => {
  const result = await compareEndpoints({
    rpcA: "http://127.0.0.1:1",
    rpcB: "http://127.0.0.1:1",
    contractId: "not-a-contract",
    fromLedger: 900,
    toLedger: 1000,
    pages: 1,
    budget: 4,
  });
  assert.equal(result.exitCode, 2);
  assert.ok(result.error);

  const inverted = await compareEndpoints({
    rpcA: "http://127.0.0.1:1",
    rpcB: "http://127.0.0.1:1",
    contractId: CONTRACT,
    fromLedger: 1000,
    toLedger: 900,
    pages: 1,
    budget: 4,
  });
  assert.equal(inverted.exitCode, 2);
});

// DIFF_LIST_MAX bounds the rendered list.
test("rpc-compare: DIFF_LIST_MAX is a positive bound", () => {
  assert.ok(Number.isInteger(DIFF_LIST_MAX) && DIFF_LIST_MAX > 0);
});

// Small delay to let mock ports fully release between tests.
test("rpc-compare: teardown pause", async () => {
  await sleep(50);
});
