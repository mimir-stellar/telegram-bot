/**
 * Tests for the signed-off replay plan (Issue #787).
 *
 * Covered:
 *   - Deterministic digest over range and contract destinations
 *   - Digest ignores target/flag order but changes with network, range,
 *     contract selection, or contract id
 *   - Dry-run preview exposes and prints the digest
 *   - --send without a digest, with a malformed digest, or with a stale digest
 *     exits 2 before any RPC or Telegram work
 *   - --send with the preview digest proceeds
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildReplayPlan,
  computeReplayPlanDigest,
  isValidReplayPlanDigest,
  runReplayCli,
} from "../dist/stellar/replay.js";
import { MARKET_CONTRACT, SQUAD_CONTRACT } from "./fixtures/events.mjs";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function fakeConfig(overrides = {}) {
  return {
    marketContractId: MARKET_CONTRACT,
    squadContractId: SQUAD_CONTRACT,
    rpcUrl: "http://fake-rpc.invalid",
    horizonUrl: "http://fake-horizon.invalid",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer",
    ...overrides,
  };
}

const TARGETS = [
  { source: "market", contractId: MARKET_CONTRACT },
  { source: "squad", contractId: SQUAD_CONTRACT },
];

function capturingServer(counter) {
  return {
    async getHealth() {
      counter.health += 1;
      return { status: "healthy", oldestLedger: 3000, latestLedger: 5000 };
    },
    async getEvents() {
      counter.events += 1;
      return { events: [], cursor: "", latestLedger: 5000 };
    },
  };
}

const LOGS = [];
function progress(...args) {
  LOGS.push(args.join(" "));
}

// ── Digest properties ────────────────────────────────────────────────────────

test("buildReplayPlan produces a deterministic digest independent of target order", () => {
  const first = buildReplayPlan({
    network: "testnet",
    from: "4000",
    to: 5000,
    targets: TARGETS,
  });
  const second = buildReplayPlan({
    network: "testnet",
    from: 4000,
    to: 5000,
    targets: [...TARGETS].reverse(),
  });

  assert.equal(first.format, "mimir-replay-plan-v1");
  assert.equal(first.from, "4000");
  assert.equal(first.to, 5000);
  assert.deepEqual(first.contracts, ["market", "squad"]);
  assert.deepEqual(first.destinations, TARGETS);
  assert.match(first.digest, /^[0-9a-f]{64}$/);
  assert.equal(isValidReplayPlanDigest(first.digest), true);
  assert.equal(second.digest, first.digest);
  assert.equal(computeReplayPlanDigest(first), first.digest);
});

test("the plan digest changes when the reviewed range or destinations change", () => {
  const base = buildReplayPlan({
    network: "testnet",
    from: "4000",
    to: 5000,
    targets: TARGETS,
  });

  const variants = [
    buildReplayPlan({ network: "testnet", from: "4001", to: 5000, targets: TARGETS }),
    buildReplayPlan({ network: "testnet", from: "4000", to: 5001, targets: TARGETS }),
    buildReplayPlan({ network: "testnet", from: "4000", to: null, targets: TARGETS }),
    buildReplayPlan({
      network: "testnet",
      from: "4000",
      to: 5000,
      targets: [TARGETS[0]],
    }),
    buildReplayPlan({
      network: "testnet",
      from: "4000",
      to: 5000,
      targets: [TARGETS[0], { source: "squad", contractId: MARKET_CONTRACT }],
    }),
    buildReplayPlan({ network: "mainnet", from: "4000", to: 5000, targets: TARGETS }),
  ];

  for (const variant of variants) {
    assert.notEqual(variant.digest, base.digest);
  }
});

test("a cursor --from is part of the digest and stays stable across previews", () => {
  const cursor = "18152504818786304-0";
  const first = buildReplayPlan({
    network: "testnet",
    from: cursor,
    to: null,
    targets: TARGETS,
  });
  const second = buildReplayPlan({
    network: "testnet",
    from: ` ${cursor} `,
    to: undefined,
    targets: TARGETS,
  });
  assert.equal(first.digest, second.digest);
  assert.notEqual(
    first.digest,
    buildReplayPlan({ network: "testnet", from: "4000", to: null, targets: TARGETS }).digest,
  );
});

// ── CLI sign-off gate ────────────────────────────────────────────────────────

test("dry-run preview exposes the plan and prints its digest", async () => {
  LOGS.length = 0;
  const counter = { health: 0, events: 0 };
  const { report, exitCode } = await runReplayCli({
    argv: ["node", "replay-cli.ts", "--from", "4000", "--to", "5000"],
    deps: {
      config: fakeConfig(),
      server: capturingServer(counter),
      progress,
    },
  });

  assert.equal(exitCode, 0);
  assert.ok(report !== null);
  assert.equal(report.dryRun, true);
  assert.equal(report.plan.format, "mimir-replay-plan-v1");
  assert.equal(report.plan.network, "testnet");
  assert.equal(report.plan.from, "4000");
  assert.equal(report.plan.to, 5000);
  assert.deepEqual(report.plan.contracts, ["market", "squad"]);
  assert.deepEqual(report.plan.destinations, TARGETS);
  assert.match(report.plan.digest, /^[0-9a-f]{64}$/);
  assert.ok(
    LOGS.some((line) => line.includes(`[replay] plan      ${report.plan.digest}`)),
    "preview must print the plan digest",
  );
});

test("--send without --plan-digest is a usage error before any RPC or send", async () => {
  const counter = { health: 0, events: 0 };
  let sends = 0;
  const { report, exitCode } = await runReplayCli({
    argv: ["node", "replay-cli.ts", "--from", "4000", "--send"],
    deps: {
      config: fakeConfig(),
      server: capturingServer(counter),
      send: async () => {
        sends += 1;
      },
      progress,
    },
  });

  assert.equal(exitCode, 2);
  assert.equal(report, null);
  assert.equal(counter.health, 0);
  assert.equal(counter.events, 0);
  assert.equal(sends, 0);
});

test("--send rejects a malformed or stale plan digest without doing work", async () => {
  const expected = buildReplayPlan({
    network: "testnet",
    from: "4000",
    to: null,
    targets: TARGETS,
  }).digest;

  for (const digest of ["not-a-digest", expected.toUpperCase(), expected.slice(0, 63)]) {
    const counter = { health: 0, events: 0 };
    const { report, exitCode } = await runReplayCli({
      argv: ["node", "replay-cli.ts", "--from", "4000", "--send", "--plan-digest", digest],
      deps: {
        config: fakeConfig(),
        server: capturingServer(counter),
        send: async () => {},
        progress,
      },
    });
    assert.equal(exitCode, 2, `digest ${digest} must be rejected`);
    assert.equal(report, null);
    assert.equal(counter.health, 0);
  }

  // A stale digest for a different range is also rejected.
  const stale = buildReplayPlan({
    network: "testnet",
    from: "4000",
    to: 5000,
    targets: TARGETS,
  }).digest;
  const counter = { health: 0, events: 0 };
  const { exitCode } = await runReplayCli({
    argv: ["node", "replay-cli.ts", "--from", "4000", "--send", "--plan-digest", stale],
    deps: {
      config: fakeConfig(),
      server: capturingServer(counter),
      send: async () => {},
      progress,
    },
  });
  assert.equal(exitCode, 2);
  assert.equal(counter.health, 0);
});

test("--send requires the digest of the same destination selection", async () => {
  const bothContracts = buildReplayPlan({
    network: "testnet",
    from: "4000",
    to: null,
    targets: TARGETS,
  }).digest;

  const counter = { health: 0, events: 0 };
  const { exitCode } = await runReplayCli({
    argv: [
      "node",
      "replay-cli.ts",
      "--from",
      "4000",
      "--contract",
      "market",
      "--send",
      "--plan-digest",
      bothContracts,
    ],
    deps: {
      config: fakeConfig(),
      server: capturingServer(counter),
      send: async () => {},
      progress,
    },
  });

  assert.equal(exitCode, 2, "a preview of both contracts must not sign off market-only");
  assert.equal(counter.health, 0);
});

test("--send with the preview digest proceeds", async () => {
  const digest = buildReplayPlan({
    network: "testnet",
    from: "4000",
    to: null,
    targets: TARGETS,
  }).digest;

  const counter = { health: 0, events: 0 };
  const { report, exitCode } = await runReplayCli({
    argv: ["node", "replay-cli.ts", "--from", "4000", "--send", "--plan-digest", digest],
    deps: {
      config: fakeConfig(),
      server: capturingServer(counter),
      send: async () => {},
      progress,
    },
  });

  assert.equal(exitCode, 0);
  assert.ok(report !== null);
  assert.equal(report.dryRun, false);
  assert.equal(report.plan.digest, digest);
  assert.ok(counter.health > 0, "signed-off delivery must reach the RPC");
});
