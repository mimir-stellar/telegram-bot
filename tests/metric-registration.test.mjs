import assert from "node:assert/strict";
import test from "node:test";

import { createMetrics, MetricRegistrationError } from "../dist/metrics.js";
import { registerStellarRpcMetrics, RpcTiming } from "../dist/stellar/metrics.js";

function countOccurrences(haystack, needle) {
  let count = 0;
  let pos = 0;
  while (true) {
    const idx = haystack.indexOf(needle, pos);
    if (idx === -1) return count;
    count += 1;
    pos = idx + needle.length;
  }
}

test("idempotent registration returns the same handle and emits one HELP/TYPE block", () => {
  const registry = createMetrics();

  const builtInAgain = registry.registerCounter(
    "mimir_bot_poll_cycles_total",
    "Total number of poll cycles started.",
  );
  assert.equal(builtInAgain, registry.pollCycles);
  builtInAgain.inc(3);
  assert.equal(registry.pollCycles.value(), 3);

  const customFirst = registry.registerCounter(
    "mimir_bot_custom_events_total",
    "Total custom events observed.",
  );
  const customSecond = registry.registerCounter(
    "mimir_bot_custom_events_total",
    "Total custom events observed.",
  );
  assert.equal(customFirst, customSecond);
  customFirst.inc(2);
  customSecond.inc(5);
  assert.equal(customFirst.value(), 7);

  const gaugeFirst = registry.registerGauge(
    "mimir_bot_custom_backlog",
    "Current custom backlog depth.",
  );
  const gaugeSecond = registry.registerGauge(
    "mimir_bot_custom_backlog",
    "Current custom backlog depth.",
  );
  assert.equal(gaugeFirst, gaugeSecond);
  gaugeSecond.set(9);
  assert.equal(gaugeFirst.value(), 9);

  const output = registry.render();
  assert.equal(countOccurrences(output, "# HELP mimir_bot_poll_cycles_total "), 1);
  assert.equal(countOccurrences(output, "# TYPE mimir_bot_poll_cycles_total "), 1);
  assert.equal(countOccurrences(output, "# HELP mimir_bot_custom_events_total "), 1);
  assert.equal(countOccurrences(output, "# TYPE mimir_bot_custom_events_total counter"), 1);
  assert.ok(output.includes("mimir_bot_custom_events_total 7"), output);
  assert.equal(countOccurrences(output, "# HELP mimir_bot_custom_backlog "), 1);
  assert.equal(countOccurrences(output, "# TYPE mimir_bot_custom_backlog gauge"), 1);
  assert.ok(output.includes("mimir_bot_custom_backlog 9"), output);
});

test("conflicting metric type for the same name is rejected without corrupting exposition", () => {
  const registry = createMetrics();
  registry.pollCycles.inc(4);
  const before = registry.render();

  assert.throws(
    () =>
      registry.registerGauge(
        "mimir_bot_poll_cycles_total",
        "Total number of poll cycles started.",
      ),
    (err) => {
      assert.ok(err instanceof MetricRegistrationError);
      assert.equal(err.metricName, "mimir_bot_poll_cycles_total");
      assert.equal(err.reason, "type-conflict");
      return true;
    },
  );

  const gauge = registry.registerGauge("mimir_bot_inflight_jobs", "Current inflight jobs.");
  gauge.set(2);
  assert.throws(
    () => registry.registerCounter("mimir_bot_inflight_jobs", "Current inflight jobs."),
    (err) => err instanceof MetricRegistrationError && err.reason === "type-conflict",
  );

  const after = registry.render();
  assert.ok(before.includes("mimir_bot_poll_cycles_total 4"));
  assert.equal(countOccurrences(after, "# TYPE mimir_bot_poll_cycles_total "), 1);
  assert.equal(countOccurrences(after, "# TYPE mimir_bot_inflight_jobs "), 1);
  assert.ok(after.includes("# TYPE mimir_bot_inflight_jobs gauge"));
  assert.ok(!after.includes("# TYPE mimir_bot_inflight_jobs counter"));
});

test("conflicting HELP definition for the same name is rejected without corrupting exposition", () => {
  const registry = createMetrics();

  assert.throws(
    () =>
      registry.registerCounter(
        "mimir_bot_poll_cycles_total",
        "Different description that would create ambiguous HELP metadata.",
      ),
    (err) => {
      assert.ok(err instanceof MetricRegistrationError);
      assert.equal(err.metricName, "mimir_bot_poll_cycles_total");
      assert.equal(err.reason, "help-conflict");
      return true;
    },
  );

  assert.throws(
    () =>
      registry.registerGauge(
        "mimir_bot_consecutive_failures",
        "Conflicting gauge description.",
      ),
    (err) => err instanceof MetricRegistrationError && err.reason === "help-conflict",
  );

  const output = registry.render();
  assert.equal(countOccurrences(output, "# HELP mimir_bot_poll_cycles_total "), 1);
  assert.ok(
    output.includes("# HELP mimir_bot_poll_cycles_total Total number of poll cycles started."),
  );
});

test("invalid metric names and empty or multiline HELP strings are rejected", () => {
  const registry = createMetrics();

  for (const badName of ["", "9starts_with_digit", "has space", "bad-dash", "bad\nline"]) {
    assert.throws(
      () => registry.registerCounter(badName, "Valid help."),
      (err) => err instanceof MetricRegistrationError && err.reason === "invalid-name",
      `Expected invalid-name rejection for ${JSON.stringify(badName)}`,
    );
  }

  for (const badHelp of ["", "   ", "first line\n# TYPE injected counter", "cr\rbreak", "nul\0byte"]) {
    assert.throws(
      () => registry.registerGauge("mimir_bot_valid_name", badHelp),
      (err) => err instanceof MetricRegistrationError && err.reason === "invalid-help",
      `Expected invalid-help rejection for ${JSON.stringify(badHelp)}`,
    );
  }

  assert.ok(!registry.render().includes("mimir_bot_valid_name"));
});

test("registerStellarRpcMetrics is idempotent and rejects conflicting pre-registrations", () => {
  const registry = createMetrics();
  const first = registerStellarRpcMetrics(registry);
  const second = registerStellarRpcMetrics(registry);

  assert.equal(first.healthRequests, second.healthRequests);
  assert.equal(first.eventsRequests, second.eventsRequests);
  assert.equal(first.maxDurationMs, second.maxDurationMs);

  let now = 0;
  const timing = new RpcTiming(() => now);
  timing.record("health", 4, true);
  timing.record("events", 19, true);
  timing.record("events", 7, false);
  first.recordSummary(timing.summary());

  const output = registry.render();
  assert.equal(
    countOccurrences(output, "# HELP mimir_bot_stellar_rpc_events_requests_total "),
    1,
  );
  assert.ok(output.includes("mimir_bot_stellar_rpc_health_requests_total 1"), output);
  assert.ok(output.includes("mimir_bot_stellar_rpc_events_requests_total 2"), output);
  assert.ok(output.includes("mimir_bot_stellar_rpc_events_failures_total 1"), output);
  assert.ok(output.includes("mimir_bot_stellar_rpc_max_duration_ms 19"), output);

  const conflictingRegistry = createMetrics();
  conflictingRegistry.registerGauge(
    "mimir_bot_stellar_rpc_health_requests_total",
    "Total Soroban RPC getHealth requests recorded.",
  );
  assert.throws(
    () => registerStellarRpcMetrics(conflictingRegistry),
    (err) => err instanceof MetricRegistrationError && err.reason === "type-conflict",
  );
});
