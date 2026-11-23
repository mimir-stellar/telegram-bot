/**
 * Focused tests for the machine-readable service-level window report
 * (`ServiceLevelWindow` in `src/stellar/metrics.ts` and `src/metrics.ts`).
 */

import assert from "node:assert/strict";
import { get } from "node:http";
import test from "node:test";

import {
  createMetrics,
  DEFAULT_SERVICE_LEVEL_WINDOW_SIZE,
  formatServiceLevelWindow,
  ServiceLevelWindow,
} from "../dist/metrics.js";

function httpGet(url) {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
      res.on("error", reject);
    }).on("error", reject);
  });
}

// ── ServiceLevelWindow Unit Tests ─────────────────────────────────────────────

test("ServiceLevelWindow: initial empty window has zero samples and is explicitly marked incomplete", () => {
  const window = new ServiceLevelWindow({ windowSize: 10 });
  const report = window.report();

  assert.equal(report.schema, "mimir.service-level-window");
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.windowSize, 10);
  assert.equal(report.sampleCount, 0);

  // Incomplete window explicitly marked
  assert.equal(report.complete, false);
  assert.equal(report.incomplete, true);
  assert.deepEqual(report.completeness, {
    complete: false,
    incomplete: true,
    reasons: ["insufficient_samples"],
  });

  // Delivery indicators
  assert.deepEqual(report.delivery, {
    attempts: 0,
    sent: 0,
    failed: 0,
    successRate: null,
    failureRate: 0,
  });

  // Lag indicators
  assert.deepEqual(report.lag, {
    samples: 0,
    missingLedgerTime: 0,
    minMs: null,
    maxMs: null,
    avgMs: null,
    p50Ms: null,
    p90Ms: null,
    p95Ms: null,
    lastMs: null,
  });

  // Data gap indicators
  assert.deepEqual(report.dataGap, {
    totalGaps: 0,
    staleCursorEvents: 0,
    missingLedgerTime: 0,
    hasGaps: false,
  });
});

test("ServiceLevelWindow: default capacity is DEFAULT_SERVICE_LEVEL_WINDOW_SIZE", () => {
  const window = new ServiceLevelWindow();
  assert.equal(window.capacity, DEFAULT_SERVICE_LEVEL_WINDOW_SIZE);
  assert.equal(window.report().windowSize, DEFAULT_SERVICE_LEVEL_WINDOW_SIZE);
});

test("ServiceLevelWindow: calculates delivery success and failure rates from bounded samples", () => {
  const window = new ServiceLevelWindow({ windowSize: 5 });

  window.recordDelivery(true, 100);
  window.recordDelivery(true, 120);
  window.recordDelivery(true, 110);
  window.recordDelivery(false, null);

  const report = window.report();
  assert.equal(report.delivery.attempts, 4);
  assert.equal(report.delivery.sent, 3);
  assert.equal(report.delivery.failed, 1);
  assert.equal(report.delivery.successRate, 0.75);
  assert.equal(report.delivery.failureRate, 0.25);

  // Still incomplete because count (4) < windowSize (5)
  assert.equal(report.complete, false);
  assert.equal(report.incomplete, true);
  assert.ok(report.completeness.reasons.includes("insufficient_samples"));
});

test("ServiceLevelWindow: calculates delivery lag indicators (min, max, avg, percentiles, lastMs)", () => {
  const window = new ServiceLevelWindow({ windowSize: 5 });

  // Record 5 lag samples: 50, 10, 30, 20, 40 ms
  window.recordDelivery(true, 50);
  window.recordDelivery(true, 10);
  window.recordDelivery(true, 30);
  window.recordDelivery(true, 20);
  window.recordDelivery(true, 40);

  const report = window.report();
  assert.equal(report.lag.samples, 5);
  assert.equal(report.lag.missingLedgerTime, 0);
  assert.equal(report.lag.minMs, 10);
  assert.equal(report.lag.maxMs, 50);
  assert.equal(report.lag.avgMs, 30);
  assert.equal(report.lag.p50Ms, 30); // sorted: [10, 20, 30, 40, 50], rank 3 -> 30
  assert.equal(report.lag.p90Ms, 50); // rank ceil(0.9 * 5) = 5 -> 50
  assert.equal(report.lag.p95Ms, 50);
  assert.equal(report.lag.lastMs, 40); // most recent sample was 40

  // 5/5 valid samples with no gaps => complete!
  assert.equal(report.complete, true);
  assert.equal(report.incomplete, false);
  assert.deepEqual(report.completeness.reasons, []);
});

test("ServiceLevelWindow: distinguishes missing ledger time from 0ms lag", () => {
  const window = new ServiceLevelWindow({ windowSize: 3 });

  // 0ms lag is a valid sample (fast local delivery / zero chain lag)
  window.recordDelivery(true, 0);
  let report = window.report();
  assert.equal(report.lag.samples, 1);
  assert.equal(report.lag.missingLedgerTime, 0);
  assert.equal(report.lag.minMs, 0);
  assert.equal(report.lag.lastMs, 0);
  assert.equal(report.dataGap.missingLedgerTime, 0);

  // Missing ledger time (null)
  window.recordDelivery(true, null);
  report = window.report();
  assert.equal(report.lag.samples, 1);
  assert.equal(report.lag.missingLedgerTime, 1);
  assert.equal(report.dataGap.missingLedgerTime, 1);
  assert.equal(report.dataGap.totalGaps, 1);
  assert.equal(report.dataGap.hasGaps, true);
  assert.ok(report.completeness.reasons.includes("missing_ledger_time"));
  assert.equal(report.complete, false);
  assert.equal(report.incomplete, true);
});

test("ServiceLevelWindow: data-gap indicators increment and explicitly mark window incomplete", () => {
  const window = new ServiceLevelWindow({ windowSize: 3 });

  window.recordDelivery(true, 25);
  window.recordDelivery(true, 35);
  window.recordDataGap("stale_cursor");

  const report = window.report();
  assert.equal(report.sampleCount, 3);
  assert.equal(report.delivery.attempts, 2); // recordDataGap is not a delivery attempt
  assert.equal(report.delivery.sent, 2);
  assert.equal(report.dataGap.staleCursorEvents, 1);
  assert.equal(report.dataGap.totalGaps, 1);
  assert.equal(report.dataGap.hasGaps, true);

  // Even though sampleCount === windowSize (3/3), stale_cursor marks it incomplete!
  assert.equal(report.complete, false);
  assert.equal(report.incomplete, true);
  assert.deepEqual(report.completeness.reasons, ["stale_cursor"]);
});

test("ServiceLevelWindow: bounded rolling window evicts older samples (FIFO)", () => {
  const window = new ServiceLevelWindow({ windowSize: 3 });

  // Record 3 samples: 10, 20, 30 ms
  window.recordDelivery(true, 10);
  window.recordDelivery(true, 20);
  window.recordDelivery(true, 30);
  assert.equal(window.count, 3);
  assert.equal(window.report().lag.minMs, 10);

  // Add 4th sample: 40 ms (sample with 10 ms should roll off)
  window.recordDelivery(true, 40);
  assert.equal(window.count, 3);
  let report = window.report();
  assert.equal(report.sampleCount, 3);
  assert.equal(report.lag.minMs, 20);
  assert.equal(report.lag.maxMs, 40);
  assert.equal(report.lag.avgMs, 30); // (20 + 30 + 40) / 3 = 30

  // Add 5th sample: 50 ms (sample with 20 ms should roll off)
  window.recordDelivery(true, 50);
  report = window.report();
  assert.equal(report.lag.minMs, 30);
  assert.equal(report.lag.maxMs, 50);
  assert.equal(report.lag.avgMs, 40); // (30 + 40 + 50) / 3 = 40
});

test("ServiceLevelWindow: rolling eviction clears past data gaps once shifted out", () => {
  const window = new ServiceLevelWindow({ windowSize: 2 });

  // S1 has a data gap
  window.recordDataGap("stale_cursor");
  // S2 is a healthy send
  window.recordDelivery(true, 20);
  assert.equal(window.report().complete, false);
  assert.deepEqual(window.report().completeness.reasons, ["stale_cursor"]);

  // S3 is a healthy send — pushes out S1
  window.recordDelivery(true, 30);
  const report = window.report();
  assert.equal(report.sampleCount, 2);
  assert.equal(report.dataGap.totalGaps, 0);
  assert.equal(report.dataGap.hasGaps, false);
  assert.equal(report.complete, true);
  assert.equal(report.incomplete, false);
  assert.deepEqual(report.completeness.reasons, []);
});

test("ServiceLevelWindow: recordFromIngestion measures lag accurately with clock", () => {
  let now = 1000;
  const window = new ServiceLevelWindow({ windowSize: 5, clock: () => now });

  const ingested = { wallMs: 1_700_000_050, monoMs: 1000 };
  now = 1200; // 200ms elapsed since ingestion

  // Event was at 1_700_000 (ledgerTimeSec)
  // Confirmed wall ms = 1_700_000_050 + 200 = 1_700_000_250
  // Ledger time ms = 1_700_000 * 1000 = 1_700_000_000
  // Age ms = 250
  const ageMs = window.recordFromIngestion(1_700_000, ingested);
  assert.equal(ageMs, 250);

  const report = window.report();
  assert.equal(report.lag.samples, 1);
  assert.equal(report.lag.lastMs, 250);
});

test("ServiceLevelWindow: recordFromIngestion with invalid ledgerTime marks missing_ledger_time", () => {
  const window = new ServiceLevelWindow({ windowSize: 5 });
  const ingested = { wallMs: 1_000_000, monoMs: 100 };

  const ageMs = window.recordFromIngestion(null, ingested);
  assert.equal(ageMs, null);

  const report = window.report();
  assert.equal(report.lag.missingLedgerTime, 1);
  assert.equal(report.dataGap.hasGaps, true);
  assert.ok(report.completeness.reasons.includes("missing_ledger_time"));
});

test("ServiceLevelWindow: boundary case — windowSize <= 0 or invalid throws RangeError", () => {
  assert.throws(() => new ServiceLevelWindow({ windowSize: 0 }), RangeError);
  assert.throws(() => new ServiceLevelWindow({ windowSize: -5 }), RangeError);
  assert.throws(() => new ServiceLevelWindow({ windowSize: 2.5 }), RangeError);
  assert.throws(() => new ServiceLevelWindow({ windowSize: NaN }), RangeError);
});

test("ServiceLevelWindow: boundary case — negative lag is clamped to 0ms", () => {
  const window = new ServiceLevelWindow({ windowSize: 2 });
  window.recordDelivery(true, -50);

  const report = window.report();
  assert.equal(report.lag.samples, 1);
  assert.equal(report.lag.minMs, 0);
  assert.equal(report.lag.lastMs, 0);
});

test("ServiceLevelWindow: reset() restores initial clean state", () => {
  const window = new ServiceLevelWindow({ windowSize: 2 });
  window.recordDelivery(true, 100);
  window.recordDelivery(false, null);
  assert.equal(window.count, 2);

  window.reset();
  assert.equal(window.count, 0);
  const report = window.report();
  assert.equal(report.sampleCount, 0);
  assert.equal(report.delivery.attempts, 0);
  assert.equal(report.complete, false);
});

test("formatServiceLevelWindow: formats complete and incomplete summaries cleanly", () => {
  const window = new ServiceLevelWindow({ windowSize: 2 });
  window.recordDelivery(true, 50);

  let formatted = formatServiceLevelWindow(window.report());
  assert.ok(formatted.includes("status=incomplete(insufficient_samples)"));
  assert.ok(formatted.includes("samples=1/2"));
  assert.ok(formatted.includes("delivery_success=100%"));

  window.recordDelivery(true, 70);
  formatted = formatServiceLevelWindow(window.report());
  assert.ok(formatted.includes("status=complete"));
  assert.ok(formatted.includes("samples=2/2"));
  assert.ok(formatted.includes("delivery_success=100%"));
  assert.ok(formatted.includes("avg_lag=60ms"));
});

// ── MetricsRegistry Integration Tests ─────────────────────────────────────────

test("MetricsRegistry: serviceLevel integration tracks age, failure, and stale cursor", () => {
  const metrics = createMetrics({ serviceLevelWindowSize: 3 });

  // 1. Success with age
  metrics.recordNotificationAge(45);
  let report = metrics.serviceLevelReport();
  assert.equal(report.sampleCount, 1);
  assert.equal(report.delivery.sent, 1);
  assert.equal(report.lag.lastMs, 45);

  // 2. Failed delivery via notificationsFailed.inc()
  metrics.notificationsFailed.inc();
  report = metrics.serviceLevelReport();
  assert.equal(report.sampleCount, 2);
  assert.equal(report.delivery.failed, 1);
  assert.equal(report.delivery.attempts, 2);
  assert.equal(report.delivery.successRate, 0.5);

  // 3. Stale cursor event via staleCursorEvents.inc()
  metrics.staleCursorEvents.inc();
  report = metrics.serviceLevelReport();
  assert.equal(report.sampleCount, 3);
  assert.equal(report.dataGap.staleCursorEvents, 1);
  assert.equal(report.complete, false);
  assert.ok(report.completeness.reasons.includes("stale_cursor"));
});

test("MetricsServer: GET /service-level serves JSON report with Cache-Control: no-store", async () => {
  const metrics = createMetrics({ serviceLevelWindowSize: 2 });
  metrics.recordNotificationAge(25);
  metrics.recordNotificationAge(35);

  const server = await metrics.startServer(0, "127.0.0.1");
  try {
    const res = await httpGet(`http://127.0.0.1:${server.port}/service-level`);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(res.headers["cache-control"], "no-store");

    const json = JSON.parse(res.body);
    assert.equal(json.schema, "mimir.service-level-window");
    assert.equal(json.schemaVersion, 1);
    assert.equal(json.complete, true);
    assert.equal(json.incomplete, false);
    assert.equal(json.sampleCount, 2);
    assert.equal(json.lag.avgMs, 30);
    assert.equal(json.delivery.successRate, 1);
  } finally {
    await server.close();
  }
});

test("MetricsServer: GET /service-level ignores query strings and non-GET returns 405", async () => {
  const metrics = createMetrics();
  const server = await metrics.startServer(0, "127.0.0.1");
  try {
    // Query string ignored
    const res = await httpGet(`http://127.0.0.1:${server.port}/service-level?format=pretty`);
    assert.equal(res.statusCode, 200);
    const json = JSON.parse(res.body);
    assert.equal(json.schema, "mimir.service-level-window");

    // POST returns 405
    const postRes = await new Promise((resolve, reject) => {
      const req = get(
        `http://127.0.0.1:${server.port}/service-level`,
        { method: "POST" },
        (r) => {
          resolve({ statusCode: r.statusCode, headers: r.headers });
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(postRes.statusCode, 405);
    assert.equal(postRes.headers["allow"], "GET");
    assert.equal(postRes.headers["cache-control"], "no-store");
  } finally {
    await server.close();
  }
});
