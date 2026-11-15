import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_PROVIDER_PROGRESS_WINDOW,
  DEFAULT_PROVIDER_STALE_AFTER_MS,
  ProviderProgressTracker,
  RpcResponseShapeError,
} from "../dist/stellar/rpc-guard.js";
import {
  LedgerWindowError,
  assessProviderWindowProgress,
} from "../dist/stellar/client.js";

describe("ProviderProgressTracker (#806)", () => {
  it("starts in warming-up state on the initial observation without flagging staleness", () => {
    const tracker = new ProviderProgressTracker({ staleAfterMs: 30_000 });
    assert.equal(tracker.snapshot(), null);
    assert.equal(tracker.historyCount(), 0);

    const first = tracker.observe({
      latestLedger: 500_000,
      eventCount: 0,
      observedAtMs: 1_000,
    });

    assert.equal(first.state, "warming-up");
    assert.equal(first.stale, false);
    assert.equal(first.streamIdle, true);
    assert.equal(first.reason, null);
    assert.equal(first.latestLedger, 500_000);
    assert.equal(first.anchorLedger, 500_000);
    assert.equal(first.ledgerDelta, 0);
    assert.equal(first.elapsedSinceAdvanceMs, 0);
    assert.equal(first.consecutiveIdleObservations, 1);
    assert.equal(first.samples, 1);
  });

  it("does NOT flag an up-to-date provider as stale when zero events exist across many intervals", () => {
    const tracker = new ProviderProgressTracker({ staleAfterMs: 30_000 });

    tracker.observe({ latestLedger: 1_000, eventCount: 0, observedAtMs: 0 });

    // Simulate 20 poll cycles over 10 minutes with zero contract events while ledgers advance
    for (let i = 1; i <= 20; i++) {
      const res = tracker.observe({
        latestLedger: 1_000 + i * 6,
        eventCount: 0,
        observedAtMs: i * 30_000,
      });
      assert.equal(res.state, "idle-stream");
      assert.equal(res.stale, false);
      assert.equal(res.streamIdle, true);
      assert.equal(res.reason, null);
      assert.equal(res.ledgerDelta, 6);
      assert.equal(res.elapsedSinceAdvanceMs, 0);
      assert.equal(res.consecutiveIdleObservations, i + 1);
    }

    // History ring stays bounded at DEFAULT_PROVIDER_PROGRESS_WINDOW
    assert.equal(tracker.historyCount(), DEFAULT_PROVIDER_PROGRESS_WINDOW);
  });

  it("keeps an already-advancing provider healthy during sub-interval polls before the next ledger closes", () => {
    const tracker = new ProviderProgressTracker({ staleAfterMs: 30_000 });

    tracker.observe({ latestLedger: 2_000, eventCount: 0, observedAtMs: 0 });
    const advanced = tracker.observe({
      latestLedger: 2_001,
      eventCount: 0,
      observedAtMs: 5_000,
    });
    assert.equal(advanced.state, "idle-stream");
    assert.equal(advanced.stale, false);

    // Polled again 3s later before ledger 2002 closes (< 30s staleAfterMs)
    const betweenLedgers = tracker.observe({
      latestLedger: 2_001,
      eventCount: 0,
      observedAtMs: 8_000,
    });
    assert.equal(betweenLedgers.state, "idle-stream");
    assert.equal(betweenLedgers.stale, false);
    assert.equal(betweenLedgers.reason, null);
    assert.equal(betweenLedgers.elapsedSinceAdvanceMs, 3_000);
  });

  it("classifies active event delivery on an advancing provider as active-stream and resets idle streak", () => {
    const tracker = new ProviderProgressTracker({ staleAfterMs: 30_000 });

    tracker.observe({ latestLedger: 3_000, eventCount: 0, observedAtMs: 0 });
    tracker.observe({ latestLedger: 3_005, eventCount: 0, observedAtMs: 25_000 });

    const active = tracker.observe({
      latestLedger: 3_010,
      eventCount: 4,
      observedAtMs: 50_000,
    });

    assert.equal(active.state, "active-stream");
    assert.equal(active.stale, false);
    assert.equal(active.streamIdle, false);
    assert.equal(active.reason, null);
    assert.equal(active.eventCount, 4);
    assert.equal(active.consecutiveIdleObservations, 0);
  });

  it("flags stale-provider (ledger-stalled) once latestLedger fails to advance across staleAfterMs", () => {
    const tracker = new ProviderProgressTracker({ staleAfterMs: 60_000 });

    tracker.observe({ latestLedger: 10_000, eventCount: 0, observedAtMs: 1_000 });

    // Just below the boundary (59,999 ms elapsed): still warming-up, not stale
    const beforeBoundary = tracker.observe({
      latestLedger: 10_000,
      eventCount: 0,
      observedAtMs: 60_999,
    });
    assert.equal(beforeBoundary.stale, false);
    assert.equal(beforeBoundary.reason, null);

    // Exact boundary (60,000 ms elapsed with zero ledger progress): stale-provider
    const atBoundary = tracker.observe({
      latestLedger: 10_000,
      eventCount: 0,
      observedAtMs: 61_000,
    });
    assert.equal(atBoundary.state, "stale-provider");
    assert.equal(atBoundary.stale, true);
    assert.equal(atBoundary.reason, "ledger-stalled");
    assert.equal(atBoundary.elapsedSinceAdvanceMs, 60_000);

    // Even if cached events are returned on a stalled tip, provider remains stale
    const cachedReplayOnStalledTip = tracker.observe({
      latestLedger: 10_000,
      eventCount: 2,
      observedAtMs: 75_000,
    });
    assert.equal(cachedReplayOnStalledTip.state, "stale-provider");
    assert.equal(cachedReplayOnStalledTip.stale, true);
    assert.equal(cachedReplayOnStalledTip.streamIdle, false);
    assert.equal(cachedReplayOnStalledTip.reason, "ledger-stalled");

    // Once latestLedger advances again, staleness clears immediately
    const recovered = tracker.observe({
      latestLedger: 10_015,
      eventCount: 0,
      observedAtMs: 80_000,
    });
    assert.equal(recovered.state, "idle-stream");
    assert.equal(recovered.stale, false);
    assert.equal(recovered.reason, null);
    assert.equal(recovered.elapsedSinceAdvanceMs, 0);
  });

  it("flags stale-provider (ledger-regressed) immediately when latestLedger moves backwards", () => {
    const tracker = new ProviderProgressTracker({ staleAfterMs: 60_000 });

    tracker.observe({ latestLedger: 20_000, eventCount: 1, observedAtMs: 1_000 });
    const regressed = tracker.observe({
      latestLedger: 19_995,
      eventCount: 1,
      observedAtMs: 6_000,
    });

    assert.equal(regressed.state, "stale-provider");
    assert.equal(regressed.stale, true);
    assert.equal(regressed.reason, "ledger-regressed");
    assert.equal(regressed.anchorLedger, 20_000);
    assert.equal(regressed.ledgerDelta, -5);

    // Catching back up only to 19,998 is still below the 20,000 anchor
    const stillBehindAnchor = tracker.observe({
      latestLedger: 19_998,
      eventCount: 0,
      observedAtMs: 10_000,
    });
    assert.equal(stillBehindAnchor.stale, true);
    assert.equal(stillBehindAnchor.reason, "ledger-regressed");

    // Surpassing the 20,000 anchor restores healthy state
    const surpassed = tracker.observe({
      latestLedger: 20_001,
      eventCount: 0,
      observedAtMs: 15_000,
    });
    assert.equal(surpassed.state, "idle-stream");
    assert.equal(surpassed.stale, false);
    assert.equal(surpassed.anchorLedger, 20_001);
  });

  it("validates getEvents responses via observeEventsResponse and enforces bounded windowSize", () => {
    let clock = 10_000;
    const tracker = new ProviderProgressTracker({
      staleAfterMs: DEFAULT_PROVIDER_STALE_AFTER_MS,
      windowSize: 3,
      now: () => clock,
    });

    tracker.observeEventsResponse({ events: [], cursor: "1-0", latestLedger: 500 });
    clock += 5_000;
    const second = tracker.observeEventsResponse({
      events: [],
      cursor: "2-0",
      latestLedger: 501,
    });
    assert.equal(second.state, "idle-stream");
    assert.equal(second.stale, false);

    clock += 5_000;
    tracker.observeEventsResponse({ events: [], cursor: "3-0", latestLedger: 502 });
    clock += 5_000;
    tracker.observeEventsResponse({ events: [], cursor: "4-0", latestLedger: 503 });
    assert.equal(tracker.historyCount(), 3);

    // Missing latestLedger in getEvents response is rejected when evaluating progress
    assert.throws(
      () => tracker.observeEventsResponse({ events: [], cursor: "5-0" }),
      (err) => {
        assert.ok(err instanceof RpcResponseShapeError);
        assert.equal(err.problem, "latest-ledger-invalid");
        return true;
      },
    );

    tracker.reset();
    assert.equal(tracker.snapshot(), null);
    assert.equal(tracker.historyCount(), 0);
  });

  it("rejects invalid constructor options and malformed observation inputs", () => {
    assert.throws(() => new ProviderProgressTracker({ staleAfterMs: 0 }), RangeError);
    assert.throws(() => new ProviderProgressTracker({ staleAfterMs: -5 }), RangeError);
    assert.throws(() => new ProviderProgressTracker({ windowSize: 0 }), RangeError);

    const tracker = new ProviderProgressTracker();
    assert.throws(
      () => tracker.observe({ latestLedger: -1 }),
      (err) => err instanceof RpcResponseShapeError && err.problem === "latest-ledger-invalid",
    );
    assert.throws(
      () => tracker.observe({ latestLedger: 100, eventCount: -1 }),
      RangeError,
    );
    assert.throws(
      () => tracker.observe({ latestLedger: 100, observedAtMs: Number.NaN }),
      RangeError,
    );
  });
});

describe("assessProviderWindowProgress (#806)", () => {
  it("compares two validated getHealth ledger windows across a bounded interval", () => {
    const quietButHealthy = assessProviderWindowProgress(
      {
        window: { oldestLedger: 1_000, latestLedger: 5_000 },
        observedAtMs: 0,
        eventCount: 0,
      },
      {
        window: { oldestLedger: 1_010, latestLedger: 5_012 },
        observedAtMs: 60_000,
        eventCount: 0,
      },
      { staleAfterMs: 30_000 },
    );
    assert.equal(quietButHealthy.state, "idle-stream");
    assert.equal(quietButHealthy.stale, false);

    const stalled = assessProviderWindowProgress(
      {
        window: { oldestLedger: 1_000, latestLedger: 5_000 },
        observedAtMs: 0,
      },
      {
        window: { oldestLedger: 1_000, latestLedger: 5_000 },
        observedAtMs: 30_000,
        eventCount: 0,
      },
      { staleAfterMs: 30_000 },
    );
    assert.equal(stalled.state, "stale-provider");
    assert.equal(stalled.stale, true);
    assert.equal(stalled.reason, "ledger-stalled");
  });

  it("rejects malformed getHealth windows via LedgerWindowError", () => {
    assert.throws(
      () =>
        assessProviderWindowProgress(
          { window: { oldestLedger: 5_000, latestLedger: 4_000 }, observedAtMs: 0 },
          { window: { oldestLedger: 5_000, latestLedger: 5_010 }, observedAtMs: 5_000 },
        ),
      (err) => err instanceof LedgerWindowError && err.problem === "malformed-window",
    );
  });
});
