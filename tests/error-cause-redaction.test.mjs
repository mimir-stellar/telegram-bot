import assert from "node:assert/strict";
import test from "node:test";

import { Logger } from "../dist/logger.js";
import {
  CAUSE_DEPTH_LIMIT_MARKER,
  CIRCULAR_CAUSE_MARKER,
  DEFAULT_MAX_LEN,
  HARD_MAX_ERROR_CAUSE_DEPTH,
  MAX_ERROR_CAUSE_DEPTH,
  clearSecrets,
  redactError,
  redactErrorChain,
} from "../dist/redact.js";

const FAKE_BOT_SECRET = ["1234567890:AA", "w".repeat(33)].join("");
const FAKE_SEED = `S${"B".repeat(55)}`;

test.afterEach(() => {
  clearSecrets();
  Logger.reset();
});

test("handles self-referential and mutual cyclic error causes without throwing", () => {
  const selfCyclic = new Error(`outer failed for ${FAKE_BOT_SECRET}`);
  selfCyclic.cause = selfCyclic;

  const selfOut = redactError(selfCyclic);
  assert.equal(selfOut.includes(FAKE_BOT_SECRET), false);
  assert.equal(selfOut.includes("[REDACTED]"), true);
  assert.equal(selfOut.includes(CIRCULAR_CAUSE_MARKER), true);
  assert.ok(selfOut.length <= DEFAULT_MAX_LEN);

  const errA = new TypeError("rpc transport failed");
  const errB = new Error(`socket closed seed=${FAKE_SEED}`);
  errA.cause = errB;
  errB.cause = errA;

  const mutualChain = redactErrorChain(errA);
  assert.equal(mutualChain.name, "TypeError");
  assert.equal(mutualChain.summary.includes(FAKE_SEED), false);
  assert.equal(mutualChain.summary.includes("TypeError: rpc transport failed"), true);
  assert.equal(mutualChain.summary.includes("socket closed seed=[REDACTED]"), true);
  assert.equal(mutualChain.summary.includes(CIRCULAR_CAUSE_MARKER), true);
  assert.ok(mutualChain.summary.length <= DEFAULT_MAX_LEN);
});

test("bounds a 5000-deep cause chain iteratively without stack overflow", () => {
  const depthCount = 5_000;
  const root = new Error("poll cycle failed");
  let cursor = root;
  for (let i = 1; i <= depthCount; i += 1) {
    const queryLeak = i === 2 ? "?api_key=" + "abcdef1234567890" : "";
    const next = new Error(`layer-${i} https://rpc.example/soroban${queryLeak}`);
    cursor.cause = next;
    cursor = next;
  }

  const out = redactError(root);
  assert.equal(out.includes("abcdef1234567890"), false);
  assert.equal(out.includes("poll cycle failed"), true);
  assert.equal(out.includes(`layer-${MAX_ERROR_CAUSE_DEPTH}`), true);
  assert.equal(out.includes(`layer-${MAX_ERROR_CAUSE_DEPTH + 1}`), false);
  assert.equal(out.includes(CAUSE_DEPTH_LIMIT_MARKER), true);
  assert.ok(out.length <= DEFAULT_MAX_LEN, `expected <= ${DEFAULT_MAX_LEN}, got ${out.length}`);

  // Overriding maxCauseDepth above the hard cap stays bounded at HARD_MAX_ERROR_CAUSE_DEPTH.
  const clamped = redactErrorChain(root, { maxCauseDepth: 99_999, maxLen: 2_000 });
  assert.equal(clamped.summary.includes(`layer-${HARD_MAX_ERROR_CAUSE_DEPTH}`), true);
  assert.equal(clamped.summary.includes(`layer-${HARD_MAX_ERROR_CAUSE_DEPTH + 1}`), false);
  assert.equal(clamped.summary.includes(CAUSE_DEPTH_LIMIT_MARKER), true);
});

test("preserves a fixed-size useful summary including the root cause when outer message is huge", () => {
  const inner = Object.assign(
    new Error(`connect ECONNREFUSED 127.0.0.1:8000 auth=${FAKE_BOT_SECRET}`),
    { code: "ECONNREFUSED" },
  );
  const outer = new TypeError(`fetch failed payload=${"x".repeat(1_200)}`, { cause: inner });

  const summary = redactError(outer);
  assert.equal(summary.length, DEFAULT_MAX_LEN);
  assert.equal(summary.includes(FAKE_BOT_SECRET), false);
  assert.match(summary, /^TypeError: fetch failed payload=x+…; cause: /);
  assert.match(summary, /connect ECONNREFUSED 127\.0\.0\.1:8000 auth=\[REDACTED\]$/);
});

test("summarizes AggregateError children and cyclic AggregateError graphs safely", () => {
  const child1 = new Error(`endpoint a rejected ${FAKE_BOT_SECRET}`);
  const child2 = new Error("endpoint b timed out");
  const child3 = new Error("endpoint c 503");
  const child4 = new Error("endpoint d 502");
  const agg = new AggregateError([child1, child2, child3, child4], "all RPC endpoints failed");
  agg.errors.unshift(agg); // inject self-cycle inside AggregateError.errors

  const chain = redactErrorChain(agg, { maxLen: 300 });
  assert.equal(chain.summary.includes(FAKE_BOT_SECRET), false);
  assert.equal(chain.summary.includes("all RPC endpoints failed"), true);
  assert.equal(chain.summary.includes(CIRCULAR_CAUSE_MARKER), true);
  assert.equal(chain.summary.includes("+2 more"), true);
  assert.ok(chain.summary.length <= 300);
});

test("Logger JSON mode serializes Error fields with bounded redacted cause summaries and survives hostile getters", () => {
  const captured = [];
  const customSecret = "my-custom-webhook-passphrase";
  Logger.configure({
    format: "json",
    secrets: [customSecret],
    now: () => new Date("2026-11-15T15:00:00.000Z"),
    sink: (level, line) => captured.push({ level, line }),
  });

  const cyclicErr = new Error(`delivery failed (${customSecret})`);
  cyclicErr.cause = new Error(`telegram 502 ${FAKE_BOT_SECRET}`, { cause: cyclicErr });

  const hostileCauseErr = new Error("outer with throwing cause getter");
  Object.defineProperty(hostileCauseErr, "cause", {
    enumerable: false,
    get() {
      throw new Error("getter exploded");
    },
  });

  const plainCauseCycle = { message: `rpc object ${customSecret}` };
  plainCauseCycle.cause = plainCauseCycle;

  assert.doesNotThrow(() => {
    Logger.error("poller", "notification failed", {
      err: cyclicErr,
      hostileErr: hostileCauseErr,
      plainErr: plainCauseCycle,
    });
  });

  assert.equal(captured.length, 1);
  const raw = captured[0].line;
  assert.equal(raw.includes(customSecret), false);
  assert.equal(raw.includes(FAKE_BOT_SECRET), false);

  const record = JSON.parse(raw);
  assert.equal(record.err.name, "Error");
  assert.match(record.err.summary, /delivery failed \(\[REDACTED\]\); cause: telegram 502 \[REDACTED\]; cause: \[circular cause\]/);
  assert.equal(record.err.cause.cause, CIRCULAR_CAUSE_MARKER);

  assert.match(record.hostileErr.summary, /outer with throwing cause getter; cause: \[unreadable cause\]/);
  assert.match(record.plainErr.summary, /rpc object \[REDACTED\]; cause: \[circular cause\]/);
});
