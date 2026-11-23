import assert from "node:assert/strict";
import test from "node:test";

import { buildMetricsReport } from "../dist/health.js";
import {
  MetricLabelError,
  createMetrics,
  escapeMetricHelp,
  escapeMetricLabelValue,
  formatMetricLabels,
  validateMetricLabelKey,
  validateMetricName,
} from "../dist/metrics.js";
import { RpcTiming, renderRpcTimingMetrics } from "../dist/stellar/metrics.js";

test("escapeMetricLabelValue escapes backslashes, double quotes, and newlines per Prometheus v0.0.4", () => {
  assert.equal(escapeMetricLabelValue("simple_value-1/2"), "simple_value-1/2");
  assert.equal(escapeMetricLabelValue('say "hello"'), 'say \\"hello\\"');
  assert.equal(escapeMetricLabelValue("path\\to\\dir/sub"), "path\\\\to\\\\dir/sub");
  assert.equal(escapeMetricLabelValue("line1\nline2"), "line1\\nline2");
  // Combined sequence: backslash before quote + newline must not double-escape quotes or leave raw LF
  const combined = escapeMetricLabelValue('a\\"b\nc\\');
  assert.equal(combined, 'a\\\\\\"b\\nc\\\\');
  assert.equal(combined.includes("\n"), false);
  // Preserves valid Unicode text
  assert.equal(escapeMetricLabelValue("Soroban 测试 🚀"), "Soroban 测试 🚀");
});

test("escapeMetricLabelValue rejects C0, DEL, and C1 control-character injection", () => {
  const hostileInputs = [
    "bad\rpaid_metric 999",
    "bad\r\nfake_metric 1",
    "null\u0000byte",
    "tab\tchar",
    "ansi\u001b[31mred\u001b[0m",
    "osc\u001b]0;pwned\u0007",
    "del\u007fchar",
    "c1\u009b31m",
  ];

  for (const input of hostileInputs) {
    assert.throws(
      () => escapeMetricLabelValue(input),
      (err) =>
        err instanceof MetricLabelError &&
        err.code === "CONTROL_CHARACTER_IN_LABEL_VALUE",
      `expected control-character rejection for ${JSON.stringify(input)}`,
    );
  }
});

test("validateMetricLabelKey and validateMetricName reject malformed or reserved keys before exposition", () => {
  assert.equal(validateMetricLabelKey("network"), "network");
  assert.equal(validateMetricLabelKey("_target_01"), "_target_01");
  assert.equal(validateMetricName("mimir_bot:custom_total"), "mimir_bot:custom_total");

  const malformedKeys = [
    "",
    "1leading_digit",
    "bad-hyphen",
    "bad.dot",
    "bad space",
    'bad"quote',
    "bad=equals",
    "bad}\nfake_metric 1",
    "bad\rkey",
    "bad\u0000key",
  ];
  for (const key of malformedKeys) {
    assert.throws(
      () => validateMetricLabelKey(key),
      (err) => err instanceof MetricLabelError && err.code === "INVALID_LABEL_KEY",
      `expected INVALID_LABEL_KEY for ${JSON.stringify(key)}`,
    );
  }

  assert.throws(
    () => validateMetricLabelKey("__name__"),
    (err) => err instanceof MetricLabelError && err.code === "RESERVED_LABEL_KEY",
  );

  assert.throws(
    () => validateMetricName("bad-metric-name"),
    (err) => err instanceof MetricLabelError && err.code === "INVALID_METRIC_NAME",
  );
});

test("formatMetricLabels and MetricsRegistry labeled metrics enforce key validation and value escaping", () => {
  assert.equal(formatMetricLabels(undefined), "");
  assert.equal(formatMetricLabels({}), "");
  assert.equal(
    formatMetricLabels({ source: 'mar"ket', note: "a\\b\nc" }),
    '{source="mar\\"ket",note="a\\\\b\\nc"}',
  );

  const m = createMetrics();
  assert.throws(
    () => m.registerLabeledCounter("mimir_bot_test_total", "test", ["bad-key"]),
    MetricLabelError,
  );
  assert.throws(
    () => m.registerLabeledGauge("mimir_bot_test_gauge", "test", ["__reserved"]),
    MetricLabelError,
  );

  const bySource = m.registerLabeledCounter(
    "mimir_bot_custom_events_total",
    "Custom events by source and detail.",
    ["source", "detail"],
  );
  bySource.inc({ detail: 'quote"slash\\newline\nok', source: "market" }, 3);
  assert.equal(bySource.value({ source: "market", detail: 'quote"slash\\newline\nok' }), 3);

  // Undeclared, missing, or control-injected labels are rejected before corrupting exposition
  assert.throws(
    () => bySource.inc({ source: "market", detail: "ok", extra: "1" }),
    (err) => err instanceof MetricLabelError && err.code === "UNDECLARED_LABEL_KEY",
  );
  assert.throws(
    () => bySource.inc({ source: "market" }),
    (err) => err instanceof MetricLabelError && err.code === "MISSING_LABEL_KEY",
  );
  assert.throws(
    () => bySource.inc({ source: "market", detail: "inject\r\nfake_metric 99" }),
    (err) => err instanceof MetricLabelError && err.code === "CONTROL_CHARACTER_IN_LABEL_VALUE",
  );

  const out = m.render();
  assert.match(
    out,
    /mimir_bot_custom_events_total\{source="market",detail="quote\\"slash\\\\newline\\nok"\} 3/,
  );
  assert.equal(out.includes("fake_metric"), false);
});

test("renderRpcTimingMetrics and buildMetricsReport neutralize label breakout and reject control injection", () => {
  let t = 0;
  const timing = new RpcTiming(() => t);
  timing.record("events", 25, true);

  const rpcOut = renderRpcTimingMetrics(timing.summary(), { env: 'stage"1\nnext' });
  assert.match(
    rpcOut,
    /mimir_stellar_rpc_operation_requests_total\{env="stage\\"1\\nnext",operation="events"\} 1/,
  );
  assert.throws(
    () => renderRpcTimingMetrics(timing.summary(), { "bad-key": "x" }),
    MetricLabelError,
  );
  assert.throws(
    () => renderRpcTimingMetrics(timing.summary(), { env: "bad\u001b[2J" }),
    MetricLabelError,
  );

  const config = {
    version: "0.1.0",
    marketContractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    squadContractId: "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    botToken: ["000000:fake", "secret"].join("-"),
    chatIds: ["-1001234567890"],
    pollIntervalMs: 30_000,
    startLookbackLedgers: 60,
    cursorFile: "/tmp/unused.json",
    maxNotificationsPerCycle: 20,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
  };
  const basePoller = {
    running: true,
    paused: false,
    startedAt: 1_000,
    cycles: 2,
    lastPollAt: 2_000,
    lastSuccessAt: 2_000,
    latestLedger: 100,
    oldestLedger: 10,
    chainClockAt: 2_000,
    notificationsSent: 1,
    notificationsFailed: 0,
    eventsSkipped: 0,
    deadLetter: { depth: 0, enqueued: 0, replayed: 0, dropped: 0 },
    consecutiveFailures: 0,
    lastError: null,
    targets: [
      {
        source: "market",
        contractId: 'CABC"}\n# injected\nfake_metric{a="b',
        cursor: null,
        lastEventLedger: 99,
        lastError: null,
      },
    ],
  };

  const report = buildMetricsReport(config, basePoller, 3_000);
  assert.match(
    report,
    /mimir_telegram_target_last_event_ledger\{network="testnet",source="market",contract="CABC\\"\}\\n# injected\\nfake_metric\{a=\\"b"\} 99/,
  );

  // Control character in target contractId is rejected before exposition
  assert.throws(
    () =>
      buildMetricsReport(
        config,
        {
          ...basePoller,
          targets: [
            {
              ...basePoller.targets[0],
              contractId: "CABC\r\nfake_metric 1",
            },
          ],
        },
        3_000,
      ),
    (err) => err instanceof MetricLabelError && err.code === "CONTROL_CHARACTER_IN_LABEL_VALUE",
  );
});

test("escapeMetricHelp and labeled registration prevent HELP comment breakout and reject controls", () => {
  assert.equal(escapeMetricHelp("plain help"), "plain help");
  assert.equal(escapeMetricHelp("a\\b\nc"), "a\\\\b\\nc");

  for (const bad of ["ok\r\ninjected 1", "null\u0000byte", "tab\there", "ansi\u001b[31mred"]) {
    assert.throws(
      () => escapeMetricHelp(bad),
      (err) => err instanceof MetricLabelError && err.code === "CONTROL_CHARACTER_IN_HELP",
    );
  }

  const m = createMetrics();
  // Reproduces the review case: newline in help text must not emit an active sample line
  const demo = m.registerLabeledCounter(
    "review_demo_total",
    "ok\\path\nreview_injected_metric 999",
    ["route"],
  );
  demo.inc({ route: "synthetic" });

  const out = m.render();
  const lines = out.split("\n");
  assert.ok(
    lines.includes("# HELP review_demo_total ok\\\\path\\nreview_injected_metric 999"),
    "HELP line must escape backslashes and newlines",
  );
  assert.equal(
    lines.some((line) => line.startsWith("review_injected_metric")),
    false,
    "injected sample must not escape the # HELP comment line",
  );

  assert.throws(
    () => m.registerLabeledGauge("review_bad_help_gauge", "bad\r\ninjected 1", ["route"]),
    (err) => err instanceof MetricLabelError && err.code === "CONTROL_CHARACTER_IN_HELP",
  );
});

test("registerLabeledCounter and registerLabeledGauge reject duplicate metric-family names", () => {
  const m = createMetrics();

  // Colliding with built-in counter or gauge
  assert.throws(
    () => m.registerLabeledCounter("mimir_bot_poll_cycles_total", "dup", ["route"]),
    (err) => err instanceof MetricLabelError && err.code === "DUPLICATE_METRIC_NAME",
  );
  assert.throws(
    () => m.registerLabeledGauge("mimir_bot_consecutive_failures", "dup", ["route"]),
    (err) => err instanceof MetricLabelError && err.code === "DUPLICATE_METRIC_NAME",
  );

  // Colliding with a previously registered custom family
  m.registerLabeledCounter("mimir_bot_custom_unique_total", "first", ["route"]);
  assert.throws(
    () => m.registerLabeledGauge("mimir_bot_custom_unique_total", "second", ["route"]),
    (err) => err instanceof MetricLabelError && err.code === "DUPLICATE_METRIC_NAME",
  );
});
