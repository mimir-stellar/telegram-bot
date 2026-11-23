import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { setImmediate as yieldToIO } from "node:timers/promises";
import test from "node:test";
import { rpc } from "@stellar/stellar-sdk";

import { createPoller } from "../dist/poller.js";
import { startMockRpc } from "../dist/stellar/mock-rpc.js";
import {
  MOCK_MARKET_CONTRACT_ID,
  MOCK_SQUAD_CONTRACT_ID,
  MOCK_NETWORK_PASSPHRASE,
  MOCK_BOT_TOKEN,
  MOCK_CHAT_ID,
} from "../dist/stellar/mock-constants.js";
import { createTempDataDir } from "./helpers/temp-data.mjs";

const SEED = 0x0525c0de;
const SEQUENCES = 300;
const STEPS = 64;
const POLL_INTERVAL_MS = 100;
const SHUTDOWN_TIMEOUT_MS = 250;
const START_AT = Date.UTC(2026, 9, 17);

// Mulberry32: reproducible across Node versions, with no property-test dependency.
function randomFrom(seed) {
  return () => {
    let value = (seed += 0x6d2b79f5);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 2 ** 32;
  };
}

function commandsFrom(random) {
  // Vary shutdown's position so the absorbing stopped state does not consume
  // most of every sequence; random controls continue after shutdown as well.
  const shutdownAt = 16 + Math.floor(random() * 32);
  return Array.from({ length: STEPS }, (_, index) => {
    const choices = ["pause", "resume", "tick", "tick"];
    if (index > shutdownAt) choices.push("shutdown");
    const name = index === shutdownAt ? "shutdown" : choices[Math.floor(random() * choices.length)];
    return name === "tick"
      ? { name, ms: [1, 49, 100, 200][Math.floor(random() * 4)], complete: random() < 0.65 }
      : { name };
  });
}

// The model owns its clock, scheduled work and shutdown requests. It never
// derives an expected transition or cycle count from the poller's status.
class ControlModel {
  state = "running";
  now = START_AT;
  cycles = 1; // start() begins one cycle immediately.
  inFlight = true;
  dueAt = null;
  resumePending = false;
  requests = [];

  pause() {
    if (this.state === "stopping" || this.state === "stopped") return "stopped";
    if (this.state === "paused") return "already-paused";
    this.state = "paused";
    this.dueAt = null;
    this.resumePending = false;
    return "paused";
  }

  resume() {
    if (this.state === "stopping" || this.state === "stopped") return "stopped";
    if (this.state === "running") return "already-running";
    this.state = "running";
    if (this.inFlight) this.resumePending = true;
    else this.dueAt = this.now;
    return "resumed";
  }

  shutdown() {
    if (this.state !== "stopped") this.state = "stopping";
    this.dueAt = null;
    this.resumePending = false;
    const request = { startedAt: this.now, result: null };
    this.requests.push(request);
    if (!this.inFlight) this.finishShutdown(request, true);
    return request;
  }

  finishShutdown(request, drained) {
    request.result = { drained, flushed: true, waitedMs: this.now - request.startedAt };
    this.state = "stopped";
  }

  tick(ms) {
    this.now += ms;
    for (const request of this.requests) {
      if (!request.result && this.now - request.startedAt >= SHUTDOWN_TIMEOUT_MS) {
        this.finishShutdown(request, false);
      }
    }
    if (this.state === "running" && this.dueAt !== null && this.dueAt <= this.now) {
      assert.equal(this.inFlight, false, "model must never overlap cycles");
      this.inFlight = true;
      this.cycles += 1;
      this.dueAt = null;
    }
  }

  completeCycle() {
    this.inFlight = false;
    for (const request of this.requests) {
      if (!request.result) this.finishShutdown(request, true);
    }
    if (this.state === "running") {
      this.dueAt = this.now + (this.resumePending ? 0 : POLL_INTERVAL_MS);
    }
    this.resumePending = false;
  }

  status() {
    return {
      running: this.state !== "stopped",
      paused: this.state === "paused",
      // stopping remains observable after graceful shutdown has completed.
      stopping: this.state === "stopping" || this.state === "stopped",
      cycles: this.cycles,
    };
  }
}

async function waitFor(predicate) {
  // Only local HTTP/file I/O uses real time. Polling and shutdown deadlines
  // use mocked timers; a broken test still fails instead of spinning forever.
  const deadline = performance.now() + 10_000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, "local RPC/cursor I/O did not settle");
    await yieldToIO();
  }
}

function configFor(cursorFile, rpcUrl) {
  return {
    marketContractId: MOCK_MARKET_CONTRACT_ID,
    squadContractId: MOCK_SQUAD_CONTRACT_ID,
    rpcUrl,
    horizonUrl: "https://example.invalid/horizon",
    networkPassphrase: MOCK_NETWORK_PASSPHRASE,
    explorerBaseUrl: "https://example.invalid/explorer",
    botToken: MOCK_BOT_TOKEN,
    chatId: MOCK_CHAT_ID,
    operatorTelegramUserId: null,
    pollIntervalMs: POLL_INTERVAL_MS,
    shutdownTimeoutMs: SHUTDOWN_TIMEOUT_MS,
    startLookbackLedgers: 60,
    cursorFile,
    maxNotificationsPerCycle: 20,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
  };
}

async function runSequence(t, mockRpc, cursorFile, commands, coverage) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: START_AT });
  const server = new rpc.Server(mockRpc.url, { allowHttp: true });
  let releaseRead = null;
  let healthReads = 0;
  const poller = createPoller({
    config: configFor(cursorFile, mockRpc.url),
    server: {
      async getHealth() {
        // Park the cycle before its real HTTP read, so operator commands can
        // interleave with work without depending on network timing.
        healthReads += 1;
        await new Promise((resolve) => { releaseRead = resolve; });
        return server.getHealth();
      },
      getEvents: (request) => server.getEvents(request),
    },
    send: async () => assert.fail("the empty mock scenario must not send notifications"),
    now: () => Date.now(),
    persistAudit: false,
  });
  const model = new ControlModel();
  const shutdowns = [];
  let step = -1;

  async function checkShutdowns() {
    for (const request of shutdowns) {
      if (request.expected.result) {
        await waitFor(() => request.settled);
        assert.deepEqual(await request.actual, request.expected.result, "shutdown result");
        coverage.add(`drained:${request.expected.result.drained}`);
        if (request.expected.result.drained && request.expected.result.waitedMs > 0) {
          coverage.add("shutdown:drained-in-flight");
        }
      } else {
        assert.equal(request.settled, false, "shutdown must wait for the cycle or deadline");
      }
    }
  }

  function checkStatus() {
    const { running, paused, stopping, cycles } = poller.status();
    assert.deepEqual({ running, paused, stopping, cycles }, model.status(), "control status and cycle starts");
    assert.equal(healthReads, model.cycles, "one health read per cycle on the mock RPC");
  }

  async function releaseCycle() {
    await waitFor(() => releaseRead !== null);
    const release = releaseRead;
    releaseRead = null;
    release();
    // No status/audit files are configured. Once this cursor write finishes,
    // the loop's remaining work is microtasks, drained before the next I/O turn.
    await waitFor(() => poller.status().lastFlushAt === Date.now());
    await yieldToIO();
  }

  try {
    await poller.start();
    await waitFor(() => releaseRead !== null);
    checkStatus();
    for (step = 0; step < commands.length; step += 1) {
      const command = commands[step];
      coverage.add(`${model.state}:${command.name}`);
      const before = poller.status();
      if (command.name === "pause") {
        assert.equal(poller.pause(), model.pause(), "pause result");
      } else if (command.name === "resume") {
        if (model.state === "paused") coverage.add(`resume:in-flight:${model.inFlight}`);
        assert.equal(poller.resume(), model.resume(), "resume result");
      } else if (command.name === "shutdown") {
        const request = { expected: model.shutdown(), settled: false };
        request.actual = poller.shutdown().then((result) => {
          request.settled = true;
          return result;
        });
        shutdowns.push(request);
      } else {
        const wasInFlight = model.inFlight;
        model.tick(command.ms);
        t.mock.timers.tick(command.ms);
        assert.equal(poller.status().cycles, model.cycles, "scheduled cycle starts");
        // Settle expired shutdowns before releasing work, so a timeout cannot
        // accidentally become a successful drain in the test harness.
        await checkShutdowns();
        if (wasInFlight && command.complete) {
          await releaseCycle();
          model.completeCycle();
        }
        if (model.inFlight) await waitFor(() => releaseRead !== null);
      }
      await checkShutdowns();
      checkStatus();
      assert.equal(Date.now(), model.now, "fake clock matches model time");
      if (before.paused || before.stopping) {
        assert.equal(poller.status().cycles, before.cycles, "no cycle starts while paused or stopping");
        assert.equal(poller.status().lastCorrelationId, before.lastCorrelationId);
      }
    }
    assert.equal(poller.status().consecutiveFailures, 0, "commands must not cause RPC failures");
    assert.equal(poller.status().lastError, null);
  } catch (error) {
    t.diagnostic(`seed=0x${SEED.toString(16)}; step=${step}; commands=${JSON.stringify(commands.slice(0, step + 1))}`);
    throw error;
  } finally {
    // Stop scheduling first, then release any held read and drain all file I/O
    // before resetting fake timers or removing the temporary data directory.
    try {
      await poller.stop();
      if (releaseRead) await releaseCycle();
      await poller.shutdown({ timeoutMs: 0 });
      await waitFor(() => shutdowns.every((request) => request.settled));
    } finally {
      t.mock.timers.reset();
    }
  }
}

test(`poller controls match the state model (${SEQUENCES} sequences, seed=0x${SEED.toString(16)})`, { timeout: 120_000 }, async (t) => {
  t.mock.method(console, "log", () => undefined);
  t.mock.method(console, "warn", () => undefined);
  const dataDir = await createTempDataDir("mimir-poller-state-model-");
  const mockRpc = await startMockRpc({
    port: 0,
    scenario: { oldestLedger: 900, latestLedger: 1_000, ledgersPerPage: 200, events: [] },
  });
  const random = randomFrom(SEED);
  const coverage = new Set();
  try {
    for (let sequence = 0; sequence < SEQUENCES; sequence += 1) {
      const commands = commandsFrom(random);
      let passed = false;
      await t.test(`sequence ${sequence}`, async (sequenceTest) => {
        await runSequence(sequenceTest, mockRpc, dataDir.file(`${sequence}/cursor.json`), commands, coverage);
        passed = true;
      });
      if (!passed) return; // The failing subtest already prints its replay trace.
    }
    // Keep the fixed seed honest: it must exercise every command in every
    // control state, resume both idle/in-flight work, and both shutdown paths.
    for (const state of ["running", "paused", "stopping", "stopped"]) {
      for (const command of ["pause", "resume", "shutdown", "tick"]) {
        assert.ok(coverage.has(`${state}:${command}`), `missing ${state}:${command}; seed=${SEED}`);
      }
    }
    for (const outcome of ["resume:in-flight:true", "resume:in-flight:false", "drained:true", "drained:false", "shutdown:drained-in-flight"]) {
      assert.ok(coverage.has(outcome), `missing ${outcome}; seed=${SEED}`);
    }
    assert.ok(mockRpc.stats().byMethod.getEvents > SEQUENCES, "healthy cycles reached the actual mock RPC");
  } finally {
    await mockRpc.close();
    await dataDir.cleanup();
  }
});
