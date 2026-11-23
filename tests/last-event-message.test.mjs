/**
 * tests/last-event-message.test.mjs
 *
 * Focused tests for lastEventMessage(config, status) from src/bot.ts.
 *
 * Covers:
 *   1. Empty status (no targets): cold start — "No contract scan has completed yet"
 *   2. Target with no lastEvent: cold start per-target — "No event has been observed..."
 *   3. Target with a known market event (claim_created): delegates to formatEvent
 *   4. Target with an unknown / admin event: falls back to "no notification summary" line
 */

import assert from "node:assert/strict";
import test from "node:test";

import { lastEventMessage } from "../dist/bot.js";

// ---------------------------------------------------------------------------
// Shared minimal config that satisfies every code path in lastEventMessage.
// Uses the Testnet passphrase so networkLabel() returns "testnet".
// ---------------------------------------------------------------------------
const CONFIG = {
    networkPassphrase: "Test SDF Network ; September 2015",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    marketContractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    squadContractId: "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWHF",
    explorerBaseUrl: "https://stellar.expert/explorer",
    // Bot-specific fields required by BotConfig but irrelevant to these tests.
    botToken: "0000000000:SECRET-TOKEN-DO-NOT-LEAK",
    pollIntervalMs: 5000,
    chatIds: ["-1001234567890"],
    featureFlags: {},
    channelPreviewMode: false,
};

// ---------------------------------------------------------------------------
// Minimal PollerStatus factory.  Most fields are irrelevant; only `targets`
// is read by lastEventMessage.
// ---------------------------------------------------------------------------
function makeStatus(targets = []) {
    return {
        running: true,
        paused: false,
        stopping: false,
        cycles: 0,
        notificationsSent: 0,
        notificationsFailed: 0,
        notificationsDropped: 0,
        eventsSkipped: 0,
        eventsDeduplicated: 0,
        pagesScanned: 0,
        emptyPages: 0,
        lastCyclePages: 0,
        lastCycleEmptyPages: 0,
        latestLedger: null,
        oldestLedger: null,
        lastPollAt: null,
        lastSuccessAt: null,
        lastError: null,
        consecutiveFailures: 0,
        chainClockAt: null,
        cursorRewinds: 0,
        restartGaps: 0,
        lastRestartGap: null,
        deadLetter: null,
        targets,
    };
}

// ---------------------------------------------------------------------------
// Minimal PollerTarget factory.
// ---------------------------------------------------------------------------
function makeTarget(source, lastEvent = null) {
    return {
        source,
        contractId: source === "market" ? CONFIG.marketContractId : CONFIG.squadContractId,
        version: "v1",
        cursor: null,
        lastEventLedger: lastEvent?.ledger ?? null,
        lastEvent,
        lastError: null,
        cursorStalled: false,
        cyclesWithoutAdvance: 0,
        gapLedgers: 0,
        cursorResetAt: null,
        cursorUnreadable: false,
    };
}

// ---------------------------------------------------------------------------
// Minimal DecodedEvent factory for a claim_created (known market event).
// ---------------------------------------------------------------------------
function makeClaimCreatedEvent() {
    return {
        source: "market",
        contractId: CONFIG.marketContractId,
        version: "v1",
        ledger: 5_000_000,
        txHash: "", // no explorer link — keeps the footer to "_ledger N_"
        at: 1_700_000_000,
        eventId: "5000000-0",
        eventType: "contract",
        transactionIndex: 0,
        operationIndex: 0,
        inSuccessfulContractCall: true,
        payload: {
            name: "claim_created",
            claimId: 42,
            creator: "GABCD",
            category: "crypto",
        },
    };
}

// ---------------------------------------------------------------------------
// Minimal DecodedEvent factory for an admin / unknown event (no template).
// ---------------------------------------------------------------------------
function makeUnknownEvent(name = "oracle_changed") {
    return {
        source: "market",
        contractId: CONFIG.marketContractId,
        version: "v1",
        ledger: 6_000_000,
        txHash: "",
        at: 1_700_000_001,
        eventId: "6000000-0",
        eventType: "contract",
        transactionIndex: 0,
        operationIndex: 0,
        inSuccessfulContractCall: true,
        payload: {
            name,
            // oracle_changed needs newOracle; other admin events are also fine here.
            newOracle: "GABCD",
        },
    };
}

// ---------------------------------------------------------------------------
// 1. Empty status — no targets at all
// ---------------------------------------------------------------------------

test("lastEventMessage: no targets → cold-start sentinel line", () => {
    const msg = lastEventMessage(CONFIG, makeStatus([]));
    assert.equal(
        msg,
        "*Last observed events* — Stellar testnet\n\nNo contract scan has completed yet\\.",
    );
});

// ---------------------------------------------------------------------------
// 2. Single target with no lastEvent (per-target cold start)
// ---------------------------------------------------------------------------

test("lastEventMessage: target with no lastEvent → cold-start per-target line", () => {
    const msg = lastEventMessage(CONFIG, makeStatus([makeTarget("market")]));
    assert.equal(
        msg,
        "*Last observed events* — Stellar testnet\n\n" +
        "*mimir\\-market*\n" +
        "No event has been observed since this process started\\.",
    );
});

test("lastEventMessage: two targets both cold → both cold-start lines", () => {
    const msg = lastEventMessage(CONFIG, makeStatus([
        makeTarget("market"),
        makeTarget("squad"),
    ]));
    assert.equal(
        msg,
        "*Last observed events* — Stellar testnet\n\n" +
        "*mimir\\-market*\n" +
        "No event has been observed since this process started\\.\n\n" +
        "*mimir\\-squad*\n" +
        "No event has been observed since this process started\\.",
    );
});

// ---------------------------------------------------------------------------
// 3. Target with a known market event (claim_created)
//    formatEvent returns a non-null notification, so formatLastEvent returns it.
// ---------------------------------------------------------------------------

test("lastEventMessage: claim_created event → full formatted notification", () => {
    const event = makeClaimCreatedEvent();
    const msg = lastEventMessage(CONFIG, makeStatus([makeTarget("market", event)]));

    // Top-level structure: header, blank, source section header, notification, no trailing blank
    assert.match(msg, /^\*Last observed events\* — Stellar testnet\n\n\*mimir\\-market\*/);

    // The notification itself must contain the claim id and category.
    assert.match(msg, /New claim.*#42/s);
    assert.match(msg, /crypto/);

    // Footer for a tx-hash-less event: ledger only.
    assert.match(msg, /_ledger 5000000_/);

    // Must not end with a blank line (trimEnd is applied).
    assert.equal(msg.endsWith("\n"), false);
});

// ---------------------------------------------------------------------------
// 4. Target with an admin / unknown event (no notification template)
//    formatEvent returns null, so formatLastEvent emits the fallback line.
// ---------------------------------------------------------------------------

test("lastEventMessage: oracle_changed (admin) event → no-summary fallback", () => {
    const event = makeUnknownEvent("oracle_changed");
    const msg = lastEventMessage(CONFIG, makeStatus([makeTarget("market", event)]));

    assert.match(msg, /^\*Last observed events\* — Stellar testnet\n\n\*mimir\\-market\*/);

    // formatLastEvent fallback: bold "Last observed event" + event name in code span.
    // Underscores are MarkdownV2-escaped (oracle_changed → oracle\_changed) so match literally.
    assert.match(msg, /\*Last observed event\* — `oracle\\_changed`/);
    assert.match(msg, /This event has no notification summary\./);

    // Footer: ledger 6000000.
    assert.match(msg, /_ledger 6000000_/);

    assert.equal(msg.endsWith("\n"), false);
});

test("lastEventMessage: unknown-name event → fallback uses eventName field", () => {
    // Simulate a decoded-but-unrecognised event: payload.name === "unknown",
    // with payload.eventName holding the original contract event name.
    const event = {
        ...makeUnknownEvent("unknown"),
        payload: {
            name: "unknown",
            eventName: "some_future_event",
            reason: "no decoder",
        },
    };
    const msg = lastEventMessage(CONFIG, makeStatus([makeTarget("market", event)]));

    // formatLastEvent reads event.payload.eventName when name === "unknown".
    // Underscores are MarkdownV2-escaped: some_future_event → some\_future\_event.
    assert.match(msg, /`some\\_future\\_event`/);
    assert.match(msg, /This event has no notification summary\./);
});
