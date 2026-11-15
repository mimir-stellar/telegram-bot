import assert from "node:assert/strict";
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  ARCHIVE_MANIFEST_FILENAME,
  ArchiveManifestVerificationError,
  exportEventArchiveWithManifest,
  exportVerifiableScanJsonl,
  readVerifiedArchive,
  verifyArchiveManifest,
  verifyScanJsonlManifest,
} from "../dist/stellar/archive.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

function makeEvent(id, ledger = 7000 + id) {
  return {
    source: "market",
    contractId: "CMARKET_CHAIN",
    ledger,
    txHash: `0xtx${id}`,
    eventId: `${ledger}-${id}`,
    payload: {
      name: "claim_created",
      claimId: id,
      creator: "GCREATOR",
      stake: BigInt(id * 100),
      question: `Question ${id}`,
      deadline: 1700001000,
      feeBps: 100,
    },
  };
}

test("binds ordered records, network, and ledger bounds across rotated segments and verifies cleanly", async () => {
  await withTempDataDir(async (tmp) => {
    const archiveDir = tmp.file("manifest-archive");
    const events = [makeEvent(1, 7001), makeEvent(2, 7005), makeEvent(3, 7010), makeEvent(4, 7020)];

    const manifest = await exportEventArchiveWithManifest(events, {
      dir: archiveDir,
      maxBytes: 260,
      context: {
        network: "testnet",
        ledgerBounds: { fromLedger: 7000, toLedger: 7050 },
      },
    });

    assert.equal(manifest.totalRecords, 4);
    assert.ok(manifest.segments.length >= 2);

    const verified = await verifyArchiveManifest(archiveDir, {
      expectedNetwork: "testnet",
      expectedLedgerBounds: { fromLedger: 7000, toLedger: 7050 },
    });
    assert.equal(verified.events.length, 4);
    assert.deepEqual(
      verified.events.map((e) => e.eventId),
      ["7001-1", "7005-2", "7010-3", "7020-4"],
    );

    const streamed = [];
    for await (const ev of readVerifiedArchive(archiveDir, { expectedNetwork: "testnet" })) {
      streamed.push(ev);
    }
    assert.equal(streamed.length, 4);

    // Empty archive manifest binds network & ledgerBounds even with 0 records.
    const emptyDir = tmp.file("empty-manifest-archive");
    const emptyManifest = await exportEventArchiveWithManifest([], {
      dir: emptyDir,
      context: {
        network: "testnet",
        ledgerBounds: { fromLedger: 8000, toLedger: 8100 },
      },
    });
    assert.equal(emptyManifest.totalRecords, 0);
    assert.equal(emptyManifest.headChainHash, emptyManifest.genesisHash);
    const verifiedEmpty = await verifyArchiveManifest(emptyDir);
    assert.equal(verifiedEmpty.events.length, 0);
  });
});

test("rejects missing, extra, reordered, or altered records and tampered network/ledger bounds", async () => {
  await withTempDataDir(async (tmp) => {
    const baseEvents = [makeEvent(1, 7001), makeEvent(2, 7002), makeEvent(3, 7003)];

    async function createSealedCopy(name, maxBytes = 10_000) {
      const dir = tmp.file(name);
      const manifest = await exportEventArchiveWithManifest(baseEvents, {
        dir,
        maxBytes,
        context: {
          network: "testnet",
          ledgerBounds: { fromLedger: 7000, toLedger: 7010 },
        },
      });
      return { dir, manifest };
    }

    // 1. Altered record payload
    {
      const { dir, manifest } = await createSealedCopy("tamper-altered");
      const segPath = path.join(dir, manifest.segments[0].file);
      const original = await readFile(segPath, "utf8");
      await writeFile(segPath, original.replace("Question 2", "Question TAMPERED"), "utf8");

      const yielded = [];
      await assert.rejects(
        async () => {
          for await (const ev of readVerifiedArchive(dir)) {
            yielded.push(ev);
          }
        },
        (err) =>
          err instanceof ArchiveManifestVerificationError &&
          err.code === "RECORD_HASH_MISMATCH",
      );
      assert.equal(yielded.length, 0);
    }

    // 2. Reordered records within segment
    {
      const { dir, manifest } = await createSealedCopy("tamper-reordered");
      const segPath = path.join(dir, manifest.segments[0].file);
      const lines = (await readFile(segPath, "utf8")).trim().split("\n");
      const swapped = [lines[1], lines[0], lines[2]].join("\n") + "\n";
      await writeFile(segPath, swapped, "utf8");

      await assert.rejects(
        () => verifyArchiveManifest(dir),
        (err) =>
          err instanceof ArchiveManifestVerificationError &&
          err.code === "RECORD_HASH_MISMATCH",
      );
    }

    // 3. Missing record (deleted line)
    {
      const { dir, manifest } = await createSealedCopy("tamper-deleted-line");
      const segPath = path.join(dir, manifest.segments[0].file);
      const lines = (await readFile(segPath, "utf8")).trim().split("\n");
      await writeFile(segPath, lines.slice(0, 2).join("\n") + "\n", "utf8");

      await assert.rejects(
        () => verifyArchiveManifest(dir),
        (err) =>
          err instanceof ArchiveManifestVerificationError &&
          err.code === "RECORD_COUNT_MISMATCH",
      );
    }

    // 4. Missing rotated segment file & unexpected injected segment file
    {
      const { dir, manifest } = await createSealedCopy("tamper-segments", 250);
      assert.ok(manifest.segments.length >= 2);

      // Inject an unexpected segment file first
      const extraSeg = path.join(dir, "events-2099-01-01T00-00-00-000Z-999999.jsonl");
      await writeFile(
        extraSeg,
        JSON.stringify(makeEvent(9, 7009), (_, v) => (typeof v === "bigint" ? v.toString(10) : v)) + "\n",
        "utf8",
      );
      await assert.rejects(
        () => verifyArchiveManifest(dir),
        (err) =>
          err instanceof ArchiveManifestVerificationError &&
          err.code === "UNEXPECTED_SEGMENT",
      );
      await unlink(extraSeg);

      // Delete one manifest segment file
      await unlink(path.join(dir, manifest.segments[manifest.segments.length - 1].file));
      await assert.rejects(
        () => verifyArchiveManifest(dir),
        (err) =>
          err instanceof ArchiveManifestVerificationError &&
          err.code === "MISSING_SEGMENT",
      );
    }

    // 5. Tampered network or ledgerBounds in manifest JSON
    {
      const { dir } = await createSealedCopy("tamper-genesis");
      const manifestPath = path.join(dir, ARCHIVE_MANIFEST_FILENAME);
      const raw = JSON.parse(await readFile(manifestPath, "utf8"));
      raw.network = "mainnet";
      await writeFile(manifestPath, JSON.stringify(raw, null, 2) + "\n", "utf8");

      await assert.rejects(
        () => verifyArchiveManifest(dir),
        (err) =>
          err instanceof ArchiveManifestVerificationError &&
          err.code === "GENESIS_DIGEST_MISMATCH",
      );
    }

    // 6. Out-of-bounds ledger rejected at manifest creation time
    await assert.rejects(
      () =>
        exportEventArchiveWithManifest([makeEvent(1, 7500)], {
          dir: tmp.file("out-of-bounds"),
          context: { network: "testnet", ledgerBounds: { fromLedger: 7000, toLedger: 7010 } },
        }),
      (err) =>
        err instanceof ArchiveManifestVerificationError &&
        err.code === "LEDGER_OUT_OF_BOUNDS",
    );
  });
});

test("exportVerifiableScanJsonl and verifyScanJsonlManifest detect JSONL reordering and tampering", () => {
  const events = [makeEvent(1, 7001), makeEvent(2, 7002)];
  const { jsonl, manifest } = exportVerifiableScanJsonl(events, {
    network: "testnet",
    ledgerBounds: { fromLedger: 7000, toLedger: 7010 },
  });

  const verified = verifyScanJsonlManifest(jsonl, manifest, { expectedNetwork: "testnet" });
  assert.equal(verified.length, 2);

  assert.throws(
    () => verifyScanJsonlManifest(jsonl, manifest, { expectedNetwork: "mainnet" }),
    (err) =>
      err instanceof ArchiveManifestVerificationError && err.code === "NETWORK_MISMATCH",
  );

  const lines = jsonl.trim().split("\n");
  const reorderedJsonl = [lines[1], lines[0], lines[2]].join("\n") + "\n";
  assert.throws(
    () => verifyScanJsonlManifest(reorderedJsonl, manifest),
    (err) =>
      err instanceof ArchiveManifestVerificationError &&
      err.code === "RECORD_HASH_MISMATCH",
  );
});
