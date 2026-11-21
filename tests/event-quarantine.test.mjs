import assert from "node:assert/strict";
import test from "node:test";
import { xdr } from "@stellar/stellar-sdk";

import {
  createEventQuarantine,
  DEFAULT_QUARANTINE_MAX_BYTES,
  DEFAULT_QUARANTINE_MAX_AGE_MS,
  MAX_QUARANTINE_ENVELOPE_BYTES,
  extractRawEnvelope,
} from "../dist/stellar/quarantine.js";
import { decodeEvent } from "../dist/stellar/decode.js";
import { decodeGenericEvent } from "../dist/stellar/generic-decode.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

function scSymbol(name) {
  return xdr.ScVal.scvSymbol(name);
}

function scU64(val) {
  return xdr.ScVal.scvU64(xdr.Uint64.fromString(String(val)));
}

function scU32(val) {
  return xdr.ScVal.scvU32(Number(val));
}

test("quarantine constants match safe bounds", () => {
  assert.equal(DEFAULT_QUARANTINE_MAX_BYTES, 10 * 1024 * 1024);
  assert.equal(DEFAULT_QUARANTINE_MAX_AGE_MS, 7 * 24 * 60 * 60 * 1000);
  assert.equal(MAX_QUARANTINE_ENVELOPE_BYTES, 64 * 1024);
});

test("extractRawEnvelope converts ScVal topics and values to base64 XDR", () => {
  const sym = scSymbol("test_event");
  const num = scU32(42);
  const envelope = extractRawEnvelope({
    topic: [sym],
    value: num,
  });

  assert.equal(envelope.topic.length, 1);
  assert.equal(envelope.topic[0], Buffer.from(sym.toXDR()).toString("base64"));
  assert.equal(envelope.value, Buffer.from(num.toXDR()).toString("base64"));
});

test("extractRawEnvelope preserves pre-encoded base64 string topics and values", () => {
  const envelope = extractRawEnvelope({
    topic: ["AAAAAwAAAHs="],
    value: "AAAAAwAAAHw=",
  });

  assert.deepEqual(envelope.topic, ["AAAAAwAAAHs="]);
  assert.equal(envelope.value, "AAAAAwAAAHw=");
});

test("EventQuarantine persists undecodable envelopes with source identity and redaction", async () => {
  await withTempDataDir(async (tmp) => {
    const qDir = tmp.file("events-quarantine");
    const quarantine = createEventQuarantine({ dir: qDir });

    const rawEvent = {
      contractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
      ledger: 12345,
      txHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      id: "12345-1",
      ledgerClosedAt: "2026-11-19T00:00:00Z",
      topic: [scSymbol("unknown_event"), scU64(999)],
      value: scU32(10),
    };

    const fakeToken = "1234567890:" + "AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";
    const record = await quarantine.quarantine(
      rawEvent,
      "market",
      `failed to decode event with token ${fakeToken}`,
    );

    assert.equal(record.source, "market");
    assert.equal(record.contractId, rawEvent.contractId);
    assert.equal(record.ledger, 12345);
    assert.equal(record.txHash, rawEvent.txHash);
    assert.equal(record.eventId, "12345-1");
    assert.equal(record.ledgerClosedAt, "2026-11-19T00:00:00Z");
    assert.equal(record.rawEnvelope.topic.length, 2);
    assert.ok(record.rawEnvelope.value);

    // Ensure secrets in reason are redacted
    assert.equal(record.reason.includes("SECRET_TOKEN"), false);
    assert.ok(record.reason.includes("[REDACTED]"));

    await quarantine.close();

    // Verify record read back
    const readQuarantine = createEventQuarantine({ dir: qDir });
    const records = [];
    for await (const r of readQuarantine.readRecords()) {
      records.push(r);
    }
    assert.equal(records.length, 1);
    assert.equal(records[0].source, "market");
    assert.equal(records[0].ledger, 12345);
    assert.equal(records[0].eventId, "12345-1");
  });
});

test("decodeEvent integrates with opt-in quarantine for malformed and unknown events", async () => {
  await withTempDataDir(async (tmp) => {
    const qDir = tmp.file("quarantine-integration");
    const quarantine = createEventQuarantine({ dir: qDir });

    const sym = scSymbol("unsupported_event");
    const badEvent = {
      contractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
      ledger: 200,
      txHash: "abcd",
      id: "200-1",
      topic: [sym],
      value: scU32(1),
    };

    // Decode with quarantine option
    const decoded = decodeEvent("market", badEvent, { quarantine });
    assert.equal(decoded.payload.name, "unknown");
    assert.equal(decoded.payload.eventName, "unsupported_event");

    // Close quarantine to flush
    await quarantine.close();

    const readQuarantine = createEventQuarantine({ dir: qDir });
    const records = [];
    for await (const r of readQuarantine.readRecords()) {
      records.push(r);
    }

    assert.equal(records.length, 1);
    assert.equal(records[0].source, "market");
    assert.equal(records[0].ledger, 200);
    assert.equal(records[0].rawEnvelope.topic[0], Buffer.from(sym.toXDR()).toString("base64"));
  });
});

test("decodeGenericEvent integrates with opt-in quarantine for malformed payloads", async () => {
  await withTempDataDir(async (tmp) => {
    const qDir = tmp.file("generic-quarantine");
    const quarantine = createEventQuarantine({ dir: qDir });

    const badEvent = {
      contractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
      ledger: 300,
      txHash: "ffff",
      id: "300-1",
      topic: [], // empty topic array -> unknown event name
      value: null,
    };

    const decoded = decodeGenericEvent(badEvent, "squad", { quarantine });
    assert.equal(decoded.eventName, "unknown");

    await quarantine.close();

    const readQuarantine = createEventQuarantine({ dir: qDir });
    const records = [];
    for await (const r of readQuarantine.readRecords()) {
      records.push(r);
    }

    assert.equal(records.length, 1);
    assert.equal(records[0].source, "squad");
    assert.equal(records[0].ledger, 300);
  });
});

test("reprocess decodes quarantined envelopes in typed mode", async () => {
  await withTempDataDir(async (tmp) => {
    const qDir = tmp.file("reprocess-typed");
    const quarantine = createEventQuarantine({ dir: qDir });

    // Store a claim_created event (which is decodable when offline reprocessed)
    const topic0 = scSymbol("claim_created");
    const topic1 = scU64(1);
    const topic2 = xdr.ScVal.scvString("G" + "A".repeat(55));
    const val = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: scSymbol("category"), val: xdr.ScVal.scvString("crypto") }),
    ]);

    const validEvent = {
      contractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
      ledger: 500,
      txHash: "1111222233334444555566667777888811112222333344445555666677778888",
      id: "500-1",
      topic: [topic0, topic1, topic2],
      value: val,
    };

    await quarantine.quarantine(validEvent, "market", "simulated network or transient error");
    await quarantine.close();

    const reprocessQuarantine = createEventQuarantine({ dir: qDir });
    const result = await reprocessQuarantine.reprocess({ mode: "typed" });

    assert.equal(result.total, 1);
    assert.equal(result.reprocessed, 1);
    assert.equal(result.stillUndecodable, 0);
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].payload.name, "claim_created");
    assert.equal(result.events[0].payload.claimId, 1);
  });
});

test("reprocess decodes quarantined envelopes in generic mode", async () => {
  await withTempDataDir(async (tmp) => {
    const qDir = tmp.file("reprocess-generic");
    const quarantine = createEventQuarantine({ dir: qDir });

    const sym = scSymbol("custom_partner_event");
    const val = scU32(777);

    await quarantine.quarantine(
      {
        contractId: "C999",
        ledger: 600,
        txHash: "beef",
        id: "600-1",
        topic: [sym],
        value: val,
      },
      "generic",
      "no typed decoder",
    );
    await quarantine.close();

    const reprocessQuarantine = createEventQuarantine({ dir: qDir });
    const result = await reprocessQuarantine.reprocess({ mode: "generic" });

    assert.equal(result.total, 1);
    assert.equal(result.reprocessed, 1);
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].eventName, "custom_partner_event");
    assert.equal(result.events[0].payload.name, "generic");
    assert.ok(result.events[0].value.includes("777"));
  });
});

test("quarantine enforces age limits and prunes expired files", async () => {
  await withTempDataDir(async (tmp) => {
    const qDir = tmp.file("quarantine-age");
    let fakeNow = 1_700_000_000_000;

    const quarantine1 = createEventQuarantine({
      dir: qDir,
      maxAgeMs: 10_000,
      now: () => fakeNow,
    });

    await quarantine1.quarantine(
      { contractId: "C1", ledger: 10, topic: [scSymbol("evt1")] },
      "market",
      "test1",
    );
    await quarantine1.close();

    // Advance time past maxAgeMs
    fakeNow += 20_000;

    const quarantine2 = createEventQuarantine({
      dir: qDir,
      maxAgeMs: 10_000,
      now: () => fakeNow,
    });

    // Adding a second event triggers pruning of expired files
    await quarantine2.quarantine(
      { contractId: "C2", ledger: 20, topic: [scSymbol("evt2")] },
      "market",
      "test2",
    );
    await quarantine2.close();

    const records = [];
    const reader = createEventQuarantine({ dir: qDir, now: () => fakeNow });
    for await (const r of reader.readRecords()) {
      records.push(r);
    }

    // Only the second event should remain
    assert.equal(records.length, 1);
    assert.equal(records[0].contractId, "C2");
  });
});

test("quarantine enforces byte limits across rotated files", async () => {
  await withTempDataDir(async (tmp) => {
    const qDir = tmp.file("quarantine-bytes");
    const quarantine = createEventQuarantine({
      dir: qDir,
      maxBytes: 600, // Small capacity
      maxFileBytes: 250, // Rotate every ~250 bytes
    });

    for (let i = 1; i <= 5; i++) {
      await quarantine.quarantine(
        { contractId: `C${i}`, ledger: i * 100, topic: [scSymbol(`evt${i}`)] },
        "market",
        `reason ${i}`,
      );
    }
    await quarantine.close();

    const reader = createEventQuarantine({ dir: qDir });
    const records = [];
    for await (const r of reader.readRecords()) {
      records.push(r);
    }

    // Oldest entries should have been pruned to stay within maxBytes
    assert.ok(records.length < 5);
    assert.ok(records.length >= 2);
    assert.equal(records[records.length - 1].contractId, "C5");
  });
});

test("quarantine rejects envelope exceeding MAX_QUARANTINE_ENVELOPE_BYTES", async () => {
  await withTempDataDir(async (tmp) => {
    const qDir = tmp.file("quarantine-oversized");
    const quarantine = createEventQuarantine({ dir: qDir });

    const hugeTopic = "A".repeat(MAX_QUARANTINE_ENVELOPE_BYTES + 10);
    const oversizedEvent = {
      contractId: "C1",
      ledger: 100,
      topic: [hugeTopic],
    };

    await assert.rejects(
      async () => {
        await quarantine.quarantine(oversizedEvent, "market", "oversized");
      },
      /exceeds maximum envelope byte ceiling/,
    );
    await quarantine.close();
  });
});
