/**
 * Tests for the scored RPC endpoint pool.
 *
 * Covers scoring, quarantine, recovery, redaction, and deterministic behavior
 * with an injected clock.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  createEndpointPool,
  EndpointPool,
  realClock,
} from "../dist/stellar/endpoint-pool.js";

/** Test clock that returns a fixed time. */
class FixedClock {
  constructor(time) {
    this.time = time;
  }

  now() {
    return this.time;
  }

  advance(ms) {
    this.time += ms;
  }
}

test("endpoint pool: pick returns an endpoint when pool is non-empty", () => {
  const pool = createEndpointPool(["https://rpc1.example.com", "https://rpc2.example.com"]);
  const picked = pool.pick();
  assert.ok(picked === "https://rpc1.example.com" || picked === "https://rpc2.example.com");
});

test("endpoint pool: empty pool returns empty string", () => {
  const pool = createEndpointPool([]);
  const picked = pool.pick();
  assert.equal(picked, "");
});

test("endpoint pool: first pick prefers first URL when all scores equal", () => {
  const pool = createEndpointPool(["https://rpc1.example.com", "https://rpc2.example.com"]);
  const picked = pool.pick();
  assert.equal(picked, "https://rpc1.example.com");
});

test("endpoint pool: success increases score and clears consecutive failures", () => {
  const clock = new FixedClock(0);
  const pool = createEndpointPool(["https://rpc1.example.com", "https://rpc2.example.com"], { clock });

  // Report a failure on rpc1
  pool.report("https://rpc1.example.com", "error", 100);
  assert.equal(pool.snapshot().endpoints[0].consecutiveFailures, 1);

  // Report success on rpc1
  pool.report("https://rpc1.example.com", "success", 50);
  assert.equal(pool.snapshot().endpoints[0].consecutiveFailures, 0);
  assert.equal(pool.snapshot().endpoints[0].successCount, 1);
});

test("endpoint pool: consecutive failures trigger quarantine", () => {
  const clock = new FixedClock(0);
  const pool = createEndpointPool(["https://rpc1.example.com", "https://rpc2.example.com"], {
    clock,
    quarantineThreshold: 3,
  });

  // Report failures up to threshold
  pool.report("https://rpc1.example.com", "error", 100);
  pool.report("https://rpc1.example.com", "error", 100);
  pool.report("https://rpc1.example.com", "error", 100);

  const snapshot = pool.snapshot();
  assert.equal(snapshot.endpoints[0].consecutiveFailures, 3);
  assert.ok(snapshot.endpoints[0].quarantinedUntilMs > 0);
});

test("endpoint pool: quarantined endpoint is not picked if alternative exists", () => {
  const clock = new FixedClock(0);
  const pool = createEndpointPool(["https://rpc1.example.com", "https://rpc2.example.com"], {
    clock,
    quarantineThreshold: 3,
  });

  // Quarantine rpc1
  pool.report("https://rpc1.example.com", "error", 100);
  pool.report("https://rpc1.example.com", "error", 100);
  pool.report("https://rpc1.example.com", "error", 100);

  // Should pick rpc2
  const picked = pool.pick();
  assert.equal(picked, "https://rpc2.example.com");
});

test("endpoint pool: success clears quarantine", () => {
  const clock = new FixedClock(0);
  const pool = createEndpointPool(["https://rpc1.example.com", "https://rpc2.example.com"], {
    clock,
    quarantineThreshold: 3,
  });

  // Quarantine rpc1
  pool.report("https://rpc1.example.com", "error", 100);
  pool.report("https://rpc1.example.com", "error", 100);
  pool.report("https://rpc1.example.com", "error", 100);

  assert.ok(pool.snapshot().endpoints[0].quarantinedUntilMs > 0);

  // Success clears quarantine
  pool.report("https://rpc1.example.com", "success", 50);
  assert.equal(pool.snapshot().endpoints[0].quarantinedUntilMs, 0);
});

test("endpoint pool: all quarantined falls back to least-bad endpoint", () => {
  const clock = new FixedClock(0);
  const pool = createEndpointPool(["https://rpc1.example.com", "https://rpc2.example.com"], {
    clock,
    quarantineThreshold: 2,
  });

  // Give rpc1 two successes (higher score)
  pool.report("https://rpc1.example.com", "success", 50);
  pool.report("https://rpc1.example.com", "success", 50);

  // Give rpc2 one success (lower score)
  pool.report("https://rpc2.example.com", "success", 50);

  // Quarantine both
  pool.report("https://rpc1.example.com", "error", 100);
  pool.report("https://rpc1.example.com", "error", 100);
  pool.report("https://rpc2.example.com", "error", 100);
  pool.report("https://rpc2.example.com", "error", 100);

  // Should pick rpc1 (least-bad) despite being quarantined
  const picked = pool.pick();
  assert.equal(picked, "https://rpc1.example.com");
});

test("endpoint pool: score decays over time", () => {
  const clock = new FixedClock(0);
  const pool = createEndpointPool(["https://rpc1.example.com", "https://rpc2.example.com"], {
    clock,
    scoreHalfLifeMs: 1000,
  });

  // Report multiple successes on rpc1 to overcome latency penalty
  pool.report("https://rpc1.example.com", "success", 1);
  pool.report("https://rpc1.example.com", "success", 1);
  pool.report("https://rpc1.example.com", "success", 1);
  const initialScore = pool.snapshot().endpoints[0].score;

  // Advance time by half-life
  clock.advance(1000);
  const decayedScore = pool.snapshot().endpoints[0].score;

  // Score should be roughly halved
  assert.ok(decayedScore < initialScore);
  assert.ok(decayedScore > 0);
});

test("endpoint pool: higher latency reduces score", () => {
  const clock = new FixedClock(0);
  const pool = createEndpointPool(["https://rpc1.example.com", "https://rpc2.example.com"], { clock });

  // Report success with low latency on rpc1
  pool.report("https://rpc1.example.com", "success", 50);
  const lowLatencyScore = pool.snapshot().endpoints[0].score;

  // Report success with high latency on rpc2
  pool.report("https://rpc2.example.com", "success", 5000);
  const highLatencyScore = pool.snapshot().endpoints[1].score;

  // Lower latency should have higher score
  assert.ok(lowLatencyScore > highLatencyScore);
});

test("endpoint pool: prefer lower latency endpoint", () => {
  const clock = new FixedClock(0);
  const pool = createEndpointPool(["https://rpc1.example.com", "https://rpc2.example.com"], { clock });

  // Both successful, but rpc2 has lower latency
  pool.report("https://rpc1.example.com", "success", 5000);
  pool.report("https://rpc2.example.com", "success", 50);

  const picked = pool.pick();
  assert.equal(picked, "https://rpc2.example.com");
});

test("endpoint pool: quarantine duration increases with consecutive failures", () => {
  const clock = new FixedClock(0);
  const pool = createEndpointPool(["https://rpc1.example.com"], {
    clock,
    quarantineThreshold: 2,
    quarantineBaseMs: 1000,
    quarantineBackoff: 2,
  });

  // First quarantine
  pool.report("https://rpc1.example.com", "error", 100);
  pool.report("https://rpc1.example.com", "error", 100);
  const firstQuarantine = pool.snapshot().endpoints[0].quarantinedUntilMs;

  // Success to clear
  pool.report("https://rpc1.example.com", "success", 50);

  // Second quarantine (longer)
  pool.report("https://rpc1.example.com", "error", 100);
  pool.report("https://rpc1.example.com", "error", 100);
  const secondQuarantine = pool.snapshot().endpoints[0].quarantinedUntilMs;

  assert.ok(secondQuarantine > firstQuarantine);
});

test("endpoint pool: quarantine duration is capped at max", () => {
  const clock = new FixedClock(0);
  const pool = createEndpointPool(["https://rpc1.example.com"], {
    clock,
    quarantineThreshold: 2,
    quarantineBaseMs: 1000,
    quarantineBackoff: 10,
    quarantineMaxMs: 5000,
  });

  // Trigger quarantine multiple times
  for (let i = 0; i < 10; i++) {
    pool.report("https://rpc1.example.com", "success", 50);
    pool.report("https://rpc1.example.com", "error", 100);
    pool.report("https://rpc1.example.com", "error", 100);
  }

  const quarantineEnd = pool.snapshot().endpoints[0].quarantinedUntilMs;
  const quarantineDuration = quarantineEnd - clock.now();

  assert.ok(quarantineDuration <= 5000);
});

test("endpoint pool: snapshot redacts URLs with credentials", () => {
  const pool = createEndpointPool(["https://user:pass@rpc.example.com"]);
  const snapshot = pool.snapshot();

  assert.equal(snapshot.endpoints[0].url, "https://[REDACTED]@rpc.example.com");
  assert.equal(snapshot.selected, "https://[REDACTED]@rpc.example.com");
});

test("endpoint pool: snapshot redacts URLs with query credentials", () => {
  const pool = createEndpointPool(["https://rpc.example.com?token=secret123"]);
  const snapshot = pool.snapshot();

  assert.equal(snapshot.endpoints[0].url, "https://rpc.example.com?token=[REDACTED]");
});

test("endpoint pool: selection is deterministic with fixed clock", () => {
  const clock = new FixedClock(0);
  const pool1 = createEndpointPool(["https://rpc1.example.com", "https://rpc2.example.com"], { clock });
  const pool2 = createEndpointPool(["https://rpc1.example.com", "https://rpc2.example.com"], { clock });

  // Apply same reports to both pools
  for (const pool of [pool1, pool2]) {
    pool.report("https://rpc1.example.com", "success", 50);
    pool.report("https://rpc2.example.com", "success", 100);
  }

  // Should pick the same endpoint
  assert.equal(pool1.pick(), pool2.pick());
});

test("endpoint pool: snapshot includes selected endpoint", () => {
  const pool = createEndpointPool(["https://rpc1.example.com", "https://rpc2.example.com"]);
  const snapshot = pool.snapshot();

  assert.ok(snapshot.selected === "https://rpc1.example.com" || snapshot.selected === "https://rpc2.example.com");
});

test("endpoint pool: consecutive failures counter resets on success", () => {
  const clock = new FixedClock(0);
  const pool = createEndpointPool(["https://rpc1.example.com"], { clock });

  pool.report("https://rpc1.example.com", "error", 100);
  pool.report("https://rpc1.example.com", "error", 100);
  assert.equal(pool.snapshot().endpoints[0].consecutiveFailures, 2);

  pool.report("https://rpc1.example.com", "success", 50);
  assert.equal(pool.snapshot().endpoints[0].consecutiveFailures, 0);
});

test("endpoint pool: timeout counts as failure for scoring", () => {
  const clock = new FixedClock(0);
  const pool = createEndpointPool(["https://rpc1.example.com"], { clock });

  pool.report("https://rpc1.example.com", "timeout", 1000);
  assert.equal(pool.snapshot().endpoints[0].failureCount, 1);
  assert.equal(pool.snapshot().endpoints[0].consecutiveFailures, 1);
});

test("endpoint pool: report on unknown URL is ignored", () => {
  const pool = createEndpointPool(["https://rpc1.example.com"]);

  // Should not throw
  pool.report("https://unknown.example.com", "success", 50);

  const snapshot = pool.snapshot();
  assert.equal(snapshot.endpoints[0].successCount, 0);
});

test("endpoint pool: last success and failure timestamps are tracked", () => {
  const clock = new FixedClock(0);
  const pool = createEndpointPool(["https://rpc1.example.com"], { clock });

  pool.report("https://rpc1.example.com", "error", 100);
  assert.equal(pool.snapshot().endpoints[0].lastFailureMs, 0);

  clock.advance(1000);
  pool.report("https://rpc1.example.com", "success", 50);
  assert.equal(pool.snapshot().endpoints[0].lastSuccessMs, 1000);
});

test("endpoint pool: last latency is tracked on success", () => {
  const clock = new FixedClock(0);
  const pool = createEndpointPool(["https://rpc1.example.com"], { clock });

  pool.report("https://rpc1.example.com", "success", 123);
  assert.equal(pool.snapshot().endpoints[0].lastLatencyMs, 123);
});
