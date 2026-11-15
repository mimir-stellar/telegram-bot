import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  ARCHIVE_METADATA_FILENAME,
  ArchiveMetadataError,
  aggregateOfflineCaptures,
  createEventArchive,
  openVerifiedArchive,
  readArchive,
  validateArchiveMetadata,
} from "../dist/stellar/archive.js";
import {
  formatScanJsonl,
  iterateScanJsonlEvents,
  parseScanJsonlCapture,
} from "../dist/stellar/scan-jsonl.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

function makeEvent({
  id = 1,
  source = "market",
  contractId = "CMARKET_TESTNET_1",
  ledger = 1000 + id,
  name = "claim_created",
} = {}) {
  return {
    source,
    contractId,
    ledger,
    txHash: `tx-${id}`,
    eventId: `${ledger}-${id}`,
    payload:
      name === "deposited"
        ? {
            name: "deposited",
            marketId: id,
            squadId: 1,
            member: "GUSER",
            amount: 500n,
            shares: 500n,
          }
        : {
            name: "claim_created",
            claimId: id,
            creator: "GCREATOR",
            question: `Q${id}`,
            deadline: 1700001000,
            feeBps: 100,
          },
  };
}

test("readArchive and openVerifiedArchive reject contradictory rotated segment metadata before yielding any event", async () => {
  await withTempDataDir(async (tmp) => {
    const archiveDir = tmp.file("contradictory-archive");
    await mkdir(archiveDir, { recursive: true });

    // Segment 1 is valid testnet market CMARKET_A; segment 2 contradicts with CMARKET_B.
    const seg1 = path.join(archiveDir, "events-2026-11-01T00-00-00-000Z-000001.jsonl");
    const seg2 = path.join(archiveDir, "events-2026-11-01T00-01-00-000Z-000002.jsonl");
    await writeFile(
      seg1,
      JSON.stringify(makeEvent({ id: 1, contractId: "CMARKET_A", ledger: 1001 })) + "\n",
      "utf8",
    );
    await writeFile(
      seg2,
      JSON.stringify(makeEvent({ id: 2, contractId: "CMARKET_B", ledger: 1002 })) + "\n",
      "utf8",
    );

    const observed = [];
    await assert.rejects(
      async () => {
        for await (const ev of readArchive(archiveDir)) {
          observed.push(ev);
        }
      },
      (err) => err instanceof ArchiveMetadataError && err.code === "CONTRACT_MISMATCH",
    );
    assert.equal(observed.length, 0, "must not yield segment 1 events when segment 2 conflicts");

    await assert.rejects(
      () => openVerifiedArchive(archiveDir),
      (err) => err instanceof ArchiveMetadataError && err.code === "CONTRACT_MISMATCH",
    );
  });
});

test("archive sidecar metadata validates network and contract roles on write and read", async () => {
  await withTempDataDir(async (tmp) => {
    const archiveDir = tmp.file("metadata-archive");

    // Duplicate contract ID across market and squad roles is rejected synchronously.
    assert.throws(
      () =>
        createEventArchive({
          dir: archiveDir,
          metadata: {
            network: "testnet",
            contracts: { market: "CSAME", squad: "CSAME" },
          },
        }),
      (err) => err instanceof ArchiveMetadataError && err.code === "DUPLICATE_CONTRACT_ROLE",
    );

    const archive = createEventArchive({
      dir: archiveDir,
      metadata: {
        network: "testnet",
        contracts: { market: "CMARKET_T", squad: "CSQUAD_T" },
      },
    });

    await archive.append([
      makeEvent({ id: 1, source: "market", contractId: "CMARKET_T", ledger: 500 }),
      makeEvent({ id: 2, source: "squad", contractId: "CSQUAD_T", ledger: 501, name: "deposited" }),
    ]);

    // Contradictory contract ID in append batch rejects without writing partial events.
    await assert.rejects(
      () =>
        archive.append([
          makeEvent({ id: 3, source: "market", contractId: "CMARKET_T", ledger: 502 }),
          makeEvent({ id: 4, source: "market", contractId: "CMARKET_OTHER", ledger: 503 }),
        ]),
      (err) => err instanceof ArchiveMetadataError && err.code === "CONTRACT_MISMATCH",
    );
    await archive.close();

    // Reopening the same directory under mainnet metadata rejects before writing.
    const wrongNetArchive = createEventArchive({
      dir: archiveDir,
      metadata: { network: "mainnet", contracts: { market: "CMARKET_T" } },
    });
    await assert.rejects(
      () =>
        wrongNetArchive.append([
          makeEvent({ id: 5, source: "market", contractId: "CMARKET_T", ledger: 504 }),
        ]),
      (err) => err instanceof ArchiveMetadataError && err.code === "NETWORK_MISMATCH",
    );
    await wrongNetArchive.close();

    // Reading with expected mainnet metadata fails before iteration begins.
    const yieldedOnMismatch = [];
    await assert.rejects(
      async () => {
        for await (const ev of readArchive(archiveDir, { expected: { network: "mainnet" } })) {
          yieldedOnMismatch.push(ev);
        }
      },
      (err) => err instanceof ArchiveMetadataError && err.code === "NETWORK_MISMATCH",
    );
    assert.equal(yieldedOnMismatch.length, 0);

    // Valid read returns only the 2 committed events.
    const meta = await validateArchiveMetadata(archiveDir, {
      expected: { network: "testnet" },
      requireNetwork: true,
    });
    assert.equal(meta.network, "testnet");
    assert.deepEqual(meta.contracts, { market: "CMARKET_T", squad: "CSQUAD_T" });

    const validEvents = [];
    for await (const ev of readArchive(archiveDir, { expected: { network: "testnet" } })) {
      validEvents.push(ev);
    }
    assert.equal(validEvents.length, 2);
  });
});

test("JSONL metadata formatting and iteration reject contradictory headers, events, or footers up front", () => {
  const ev1 = makeEvent({ id: 1, source: "market", contractId: "CMARKET_1", ledger: 200 });
  const ev2 = makeEvent({ id: 2, source: "squad", contractId: "CSQUAD_1", ledger: 201, name: "deposited" });

  // 1-arg formatScanJsonl stays backward-compatible (no leading meta line).
  const legacy = formatScanJsonl([ev1]);
  const legacyLines = legacy.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(legacyLines.length, 2);
  assert.equal(legacyLines[0].type, "event");
  assert.equal(legacyLines[1].type, "summary");

  // With metadata, emits meta + events + summary and validates consistency.
  const tagged = formatScanJsonl([ev1, ev2], {
    network: "testnet",
    contracts: { market: "CMARKET_1", squad: "CSQUAD_1" },
  });
  const parsed = parseScanJsonlCapture(tagged, {
    expected: { network: "testnet" },
    requireNetwork: true,
  });
  assert.equal(parsed.metadata.network, "testnet");
  assert.equal(parsed.events.length, 2);

  // Tamper summary footer to claim mainnet -> iterateScanJsonlEvents yields 0 events before throwing.
  const tamperedLines = tagged.trim().split("\n");
  const footer = JSON.parse(tamperedLines[tamperedLines.length - 1]);
  footer.network = "mainnet";
  tamperedLines[tamperedLines.length - 1] = JSON.stringify(footer);
  const tamperedJsonl = tamperedLines.join("\n") + "\n";

  const seen = [];
  assert.throws(
    () => {
      for (const ev of iterateScanJsonlEvents(tamperedJsonl)) {
        seen.push(ev);
      }
    },
    (err) => err instanceof ArchiveMetadataError && err.code === "NETWORK_MISMATCH",
  );
  assert.equal(seen.length, 0);
});

test("aggregateOfflineCaptures keeps conflicting captures out of offline aggregate results", async () => {
  await withTempDataDir(async (tmp) => {
    const validDirA = tmp.file("capture-a");
    const archiveA = createEventArchive({
      dir: validDirA,
      metadata: { network: "testnet", contracts: { market: "CMARKET_T", squad: "CSQUAD_T" } },
    });
    await archiveA.append([
      makeEvent({ id: 1, source: "market", contractId: "CMARKET_T", ledger: 100 }),
      makeEvent({ id: 2, source: "market", contractId: "CMARKET_T", ledger: 105 }),
    ]);
    await archiveA.close();

    // Conflicting archive on mainnet (must be excluded completely, including ledger 9999).
    const mainnetDir = tmp.file("capture-mainnet");
    const archiveMainnet = createEventArchive({
      dir: mainnetDir,
      metadata: { network: "mainnet", contracts: { market: "CMARKET_T" } },
    });
    await archiveMainnet.append([
      makeEvent({ id: 99, source: "market", contractId: "CMARKET_T", ledger: 9999 }),
    ]);
    await archiveMainnet.close();

    // Conflicting JSONL with staging market contract ID.
    const conflictingContractJsonl = formatScanJsonl(
      [makeEvent({ id: 50, source: "market", contractId: "CMARKET_STAGING", ledger: 500 })],
      { network: "testnet", contracts: { market: "CMARKET_STAGING" } },
    );

    // Untagged JSONL missing network metadata once aggregate is pinned to testnet.
    const missingNetworkJsonl = formatScanJsonl([
      makeEvent({ id: 60, source: "market", contractId: "CMARKET_T", ledger: 600 }),
    ]);

    // Compatible second testnet capture (with one duplicate of id=2 and one new squad event).
    const validJsonlB = formatScanJsonl(
      [
        makeEvent({ id: 2, source: "market", contractId: "CMARKET_T", ledger: 105 }),
        makeEvent({ id: 3, source: "squad", contractId: "CSQUAD_T", ledger: 110, name: "deposited" }),
      ],
      { network: "testnet", contracts: { market: "CMARKET_T", squad: "CSQUAD_T" } },
    );

    // Corrupt sidecar archive to verify INVALID_METADATA quarantine.
    const corruptDir = tmp.file("capture-corrupt");
    await mkdir(corruptDir, { recursive: true });
    await writeFile(path.join(corruptDir, ARCHIVE_METADATA_FILENAME), "{bad-json", "utf8");

    const result = await aggregateOfflineCaptures([
      { id: "testnet-a", dir: validDirA },
      { id: "mainnet-conflict", dir: mainnetDir },
      { id: "staging-contract-conflict", jsonl: conflictingContractJsonl },
      { id: "untagged-missing-net", jsonl: missingNetworkJsonl },
      { id: "corrupt-sidecar", dir: corruptDir },
      { id: "testnet-b", jsonl: validJsonlB },
    ]);

    assert.deepEqual(result.acceptedCaptures, ["testnet-a", "testnet-b"]);
    assert.deepEqual(
      result.rejectedCaptures.map((r) => [r.id, r.code]),
      [
        ["mainnet-conflict", "NETWORK_MISMATCH"],
        ["staging-contract-conflict", "CONTRACT_MISMATCH"],
        ["untagged-missing-net", "MISSING_METADATA"],
        ["corrupt-sidecar", "INVALID_METADATA"],
      ],
    );
    assert.equal(result.eventCount, 3);
    assert.deepEqual(result.histogram, { claim_created: 2, deposited: 1 });
    assert.deepEqual(result.ledgerRange, { minLedger: 100, maxLedger: 110 });

    // Strict mode throws on the first conflicting capture.
    await assert.rejects(
      () =>
        aggregateOfflineCaptures(
          [
            { id: "testnet-a", dir: validDirA },
            { id: "mainnet-conflict", dir: mainnetDir },
          ],
          { onConflict: "throw" },
        ),
      (err) => err instanceof ArchiveMetadataError && err.code === "NETWORK_MISMATCH",
    );
  });
});
