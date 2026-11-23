/**
 * Focused tests for the MetricsRegistry duplicate-registration guard.
 *
 * Covers:
 *  - First registration creates and returns the metric.
 *  - Identical re-registration (same name + type + help) is accepted silently
 *    and returns the same underlying metric (idempotent).
 *  - Re-registration with a conflicting type throws MetricRegistrationError.
 *  - Re-registration with a conflicting help string throws MetricRegistrationError.
 *  - The error message is deterministic and value-free (no credentials, no
 *    remote data).
 *  - A registered metric appears in render() output exactly once even after
 *    multiple idempotent registrations.
 *  - Dynamically registered metrics appear in render() output with correct
 *    HELP / TYPE / value lines.
 *  - Counter registered via register() obeys the same inc() rules as a
 *    built-in counter.
 *  - Gauge registered via register() obeys the same set() rules as a
 *    built-in gauge.
 *  - Multiple independent registries do not share state.
 *  - The built-in metrics are themselves registered idempotently (calling
 *    register() with the exact same name + type + help returns the live
 *    counter/gauge handle).
 *
 * No live network calls, no Testnet RPC, no Telegram credentials.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createMetrics, MetricRegistrationError } from "../dist/metrics.js";

// ── First registration ──────────────────────────────��─────────────────────────

test("register: first call creates a counter that starts at zero", () => {
  const m = createMetrics();
  const c = m.register("my_app_requests_total", "counter", "Total requests.");
  assert.equal(c.value(), 0);
  assert.equal(typeof c.inc, "function");
});

test("register: first call creates a gauge that starts at zero", () => {
  const m = createMetrics();
  const g = m.register("my_app_queue_depth", "gauge", "Current queue depth.");
  assert.equal(g.value(), 0);
  assert.equal(typeof g.set, "function");
});

test("register: a counter registered via register() increments correctly", () => {
  const m = createMetrics();
  const c = m.register("my_ext_counter_total", "counter", "An external counter.");
  c.inc();
  c.inc(4);
  assert.equal(c.value(), 5);
});

test("register: a gauge registered via register() sets value correctly", () => {
  const m = createMetrics();
  const g = m.register("my_ext_gauge", "gauge", "An external gauge.");
  g.set(99);
  assert.equal(g.value(), 99);
  g.set(0);
  assert.equal(g.value(), 0);
});

test("register: counter via register() rejects negative delta", () => {
  const m = createMetrics();
  const c = m.register("my_strict_counter_total", "counter", "Strict counter.");
  assert.throws(() => c.inc(-1), /RangeError|delta must be/);
});

// ── Idempotent re-registration ────────────────────────────────────────────────

test("register: identical re-registration returns the same metric (idempotent)", () => {
  const m = createMetrics();
  const first = m.register("my_idempotent_total", "counter", "Idempotent counter.");
  first.inc(3);

  // Registering again with identical name + type + help must return the live handle.
  const second = m.register("my_idempotent_total", "counter", "Idempotent counter.");
  assert.equal(second.value(), 3, "Second registration should return the same underlying counter");

  // Incrementing via either reference updates the shared state.
  second.inc(2);
  assert.equal(first.value(), 5);
});

test("register: idempotent re-registration for a gauge preserves the current value", () => {
  const m = createMetrics();
  const first = m.register("my_idempotent_gauge", "gauge", "Idempotent gauge.");
  first.set(42);

  const second = m.register("my_idempotent_gauge", "gauge", "Idempotent gauge.");
  assert.equal(second.value(), 42);
});

test("register: idempotent re-registration can happen many times without side-effects", () => {
  const m = createMetrics();
  for (let i = 0; i < 20; i++) {
    m.register("my_repeated_total", "counter", "Repeated counter.");
  }
  const c = m.register("my_repeated_total", "counter", "Repeated counter.");
  c.inc();
  assert.equal(c.value(), 1);
  // render() must contain the metric exactly once.
  const output = m.render();
  const occurrences = (output.match(/my_repeated_total \d/g) ?? []).length;
  assert.equal(occurrences, 1, "metric value line must appear exactly once in render output");
});

// ── Conflicting type ──────────────────────────────────────────────────────────

test("register: re-registration with a different type throws MetricRegistrationError", () => {
  const m = createMetrics();
  m.register("my_typed_metric_total", "counter", "A counter.");

  assert.throws(
    () => m.register("my_typed_metric_total", "gauge", "A counter."),
    (err) => {
      assert.ok(err instanceof MetricRegistrationError, "must be MetricRegistrationError");
      assert.equal(err.metricName, "my_typed_metric_total");
      assert.equal(err.field, "type");
      assert.equal(err.existing, "counter");
      assert.equal(err.attempted, "gauge");
      return true;
    },
  );
});

test("register: type conflict error message names the metric and both types", () => {
  const m = createMetrics();
  m.register("my_conflict_metric", "gauge", "A gauge.");

  let caught;
  try {
    m.register("my_conflict_metric", "counter", "A gauge.");
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof MetricRegistrationError);
  assert.ok(
    caught.message.includes("my_conflict_metric"),
    `message must name the metric: ${caught.message}`,
  );
  assert.ok(
    caught.message.includes("gauge"),
    `message must name the existing type: ${caught.message}`,
  );
  assert.ok(
    caught.message.includes("counter"),
    `message must name the attempted type: ${caught.message}`,
  );
});

// ── Conflicting help ──────────────────────────────────────────────────────────

test("register: re-registration with a different help string throws MetricRegistrationError", () => {
  const m = createMetrics();
  m.register("my_help_metric_total", "counter", "Original help text.");

  assert.throws(
    () => m.register("my_help_metric_total", "counter", "Changed help text."),
    (err) => {
      assert.ok(err instanceof MetricRegistrationError, "must be MetricRegistrationError");
      assert.equal(err.metricName, "my_help_metric_total");
      assert.equal(err.field, "help");
      assert.equal(err.existing, "Original help text.");
      assert.equal(err.attempted, "Changed help text.");
      return true;
    },
  );
});

test("register: help conflict error message names the metric and both help strings", () => {
  const m = createMetrics();
  m.register("my_help_conflict_total", "counter", "First help.");

  let caught;
  try {
    m.register("my_help_conflict_total", "counter", "Second help.");
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof MetricRegistrationError);
  assert.ok(caught.message.includes("my_help_conflict_total"));
  assert.ok(caught.message.includes("First help."));
  assert.ok(caught.message.includes("Second help."));
});

// ── render() output integrity ─────────────────────────────────────────────────

test("register: dynamically registered counter appears in render() with HELP, TYPE, and value", () => {
  const m = createMetrics();
  const c = m.register("my_dyn_counter_total", "counter", "Dynamic counter help.");
  c.inc(7);

  const output = m.render();
  assert.ok(
    output.includes("# HELP my_dyn_counter_total Dynamic counter help."),
    `Missing HELP line: ${output}`,
  );
  assert.ok(
    output.includes("# TYPE my_dyn_counter_total counter"),
    `Missing TYPE line: ${output}`,
  );
  assert.ok(
    output.includes("my_dyn_counter_total 7"),
    `Missing value line: ${output}`,
  );
});

test("register: dynamically registered gauge appears in render() with correct TYPE", () => {
  const m = createMetrics();
  const g = m.register("my_dyn_gauge", "gauge", "Dynamic gauge help.");
  g.set(13);

  const output = m.render();
  assert.ok(output.includes("# TYPE my_dyn_gauge gauge"), `Missing TYPE gauge: ${output}`);
  assert.ok(output.includes("my_dyn_gauge 13"), `Missing value: ${output}`);
});

test("register: idempotent re-registration does not add a duplicate HELP/TYPE block", () => {
  const m = createMetrics();
  m.register("my_once_total", "counter", "Once.");
  m.register("my_once_total", "counter", "Once.");

  const output = m.render();
  const helpCount = (output.match(/# HELP my_once_total/g) ?? []).length;
  const typeCount = (output.match(/# TYPE my_once_total/g) ?? []).length;
  assert.equal(helpCount, 1, `Expected exactly one HELP line; found ${helpCount}`);
  assert.equal(typeCount, 1, `Expected exactly one TYPE line; found ${typeCount}`);
});

// ── Independence ──────────────────────────────────────────────────────────────

test("register: two independent registries do not share dynamically registered metrics", () => {
  const m1 = createMetrics();
  const m2 = createMetrics();

  const c1 = m1.register("shared_name_total", "counter", "Counter in registry 1.");
  c1.inc(10);

  // Registry 2 may also register a metric with the same name — it is a fresh registry.
  const c2 = m2.register("shared_name_total", "counter", "Counter in registry 1.");
  c2.inc(3);

  assert.equal(c1.value(), 10);
  assert.equal(c2.value(), 3);
});

// ── Built-in metrics are idempotently re-registerable ────────────────────────

test("register: re-registering a built-in counter with matching type+help returns the live handle", () => {
  const m = createMetrics();
  m.pollCycles.inc(5);

  // The built-in pollCycles was registered with these exact values:
  const again = m.register("mimir_bot_poll_cycles_total", "counter", "Total number of poll cycles started.");
  assert.equal(again.value(), 5, "idempotent re-registration must return the live counter");
  again.inc(1);
  assert.equal(m.pollCycles.value(), 6, "both references must share the same underlying state");
});

test("register: re-registering a built-in gauge with matching type+help returns the live handle", () => {
  const m = createMetrics();
  m.consecutiveFailures.set(7);

  const again = m.register(
    "mimir_bot_consecutive_failures",
    "gauge",
    "Current number of consecutive full-cycle RPC failures (resets to 0 on any success).",
  );
  assert.equal(again.value(), 7);
});

test("register: re-registering a built-in metric with a different type throws", () => {
  const m = createMetrics();
  assert.throws(
    () => m.register("mimir_bot_poll_cycles_total", "gauge", "Total number of poll cycles started."),
    (err) => {
      assert.ok(err instanceof MetricRegistrationError);
      assert.equal(err.field, "type");
      assert.equal(err.existing, "counter");
      assert.equal(err.attempted, "gauge");
      return true;
    },
  );
});

test("register: re-registering a built-in metric with a different help string throws", () => {
  const m = createMetrics();
  assert.throws(
    () => m.register("mimir_bot_poll_cycles_total", "counter", "Wrong help text."),
    (err) => {
      assert.ok(err instanceof MetricRegistrationError);
      assert.equal(err.field, "help");
      return true;
    },
  );
});

// ── MetricRegistrationError class ────────────────────────────────────────────

test("MetricRegistrationError is an instance of Error", () => {
  const err = new MetricRegistrationError("my_metric", "type", "counter", "gauge");
  assert.ok(err instanceof Error);
  assert.ok(err instanceof MetricRegistrationError);
  assert.equal(err.name, "MetricRegistrationError");
});

test("MetricRegistrationError exposes structured fields for programmatic inspection", () => {
  const err = new MetricRegistrationError("test_metric_total", "help", "Old help.", "New help.");
  assert.equal(err.metricName, "test_metric_total");
  assert.equal(err.field, "help");
  assert.equal(err.existing, "Old help.");
  assert.equal(err.attempted, "New help.");
});
