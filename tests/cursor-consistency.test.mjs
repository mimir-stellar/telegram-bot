/**
 * Read-only cursor consistency check against scan archives (issue #786).
 *
 * Synthetic fixtures only: fake `C…` contract ids, paging-token event ids
 * built from ledger numbers, and ephemeral data directories. No RPC, no
 * Telegram, no signing keys.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { checkCursorConsistency, formatCursorConsistencyReport } from "../dist/cursor-consistency.js";
import { checkCursor, readScanArchiveRecords } from "../dist/cursor-cli.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL("../dist/cursor-cli.js", import.meta.url));

const MARKET = `C${"A".repeat(55)}`;
const SQUAD = `C${"B".repeat(55)}`;
const OTHER = `C${"D".repeat(55)}`;

/** Soroban paging token (`<TOID>-<order>`) whose TOID packs `ledger`. */
function tok(ledger, order = 1) {
  return `${(BigInt(ledger) << 32n).toString().padStart(19, "0")}-${String(order).padStart(10, "0")}`;
}

function ev(source, contractId, ledger, order = 1) {
  return {
    source,
    contractId,
    version: "v1",
    ledger,
    txHash: `${"ab".repeat(16)}${String(ledger).padStart(8, "0")}${String(order).padStart(24, "0")}`,
    at: 1_700_000_000 + ledger,
    eventId: tok(ledger, order),
    eventType: "contract",
    transactionIndex: null,
    operationIndex: null,
    payload: { name: "unknown", eventName: "fixture" },
  };
}

function cursorFile(targets, extra = {}) {
  return { version: 1, updatedAt: "2026-11-21T08:00:00.000Z", targets, ...extra };
}

function target(lastEventLedger, ids = [], cursorLedger = lastEventLedger) {
  return {
    cursor: cursorLedger === null ? null : tok(cursorLedger, 1),
    lastEventLedger,
    recentEventIds: ids,
  };
}

const CLEAN_ARCHIVE = [
  ev("market", MARKET, 100),
  ev("market", MARKET, 105),
  ev("squad", SQUAD, 102),
  ev("market", MARKET, 110),
  ev("squad", SQUAD, 108),
];

const CLEAN_CURSOR = cursorFile({
  market: target(110, [tok(100), tok(105), tok(110)]),
  squad: target(108, [tok(102), tok(108)]),
});

const kinds = (report) => report.findings.map((f) => `${f.severity}:${f.kind}:${f.source ?? "archive"}`);
const find = (report, kind, source) =>
  report.findings.find((f) => f.kind === kind && (source === undefined || f.source === source));

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

// ── Pure function ───────────────────────────────────────────────────────────

test("a cursor that matches its archive is consistent with no findings", () => {
  const report = checkCursorConsistency(CLEAN_CURSOR, CLEAN_ARCHIVE, {
    expectedContracts: { market: MARKET, squad: SQUAD },
  });
  assert.equal(report.consistent, true);
  assert.equal(report.errors, 0);
  assert.equal(report.warnings, 0);
  assert.equal(report.records, 5);
  assert.deepEqual(report.findings, []);
  assert.deepEqual(
    report.targets.map((t) => [t.source, t.archive.records, t.archive.firstLedger, t.archive.lastLedger]),
    [
      ["market", 3, 100, 110],
      ["squad", 2, 102, 108],
    ],
  );
  assert.equal(report.targets[0].cursorLedger, 110);
});

test("the report is deterministic and never mutates its inputs", () => {
  const cursor = deepFreeze(structuredClone(CLEAN_CURSOR));
  const archive = deepFreeze([...CLEAN_ARCHIVE, ev("treasury", OTHER, 99), ev("market", OTHER, 111)]);
  const first = checkCursorConsistency(cursor, archive);
  const second = checkCursorConsistency(cursor, archive);
  assert.deepEqual(first, second);

  // Target key order in the cursor file does not change the report.
  const reordered = cursorFile({ squad: CLEAN_CURSOR.targets.squad, market: CLEAN_CURSOR.targets.market });
  assert.deepEqual(checkCursorConsistency(reordered, archive), first);
});

test("identity: archive targets the cursor does not track are reported as warnings", () => {
  const report = checkCursorConsistency(CLEAN_CURSOR, [...CLEAN_ARCHIVE, ev("treasury", OTHER, 99)]);
  assert.equal(report.consistent, true);
  const untracked = find(report, "archive-target-untracked", "treasury");
  assert.equal(untracked.severity, "warning");
  assert.equal(untracked.count, 1);
  assert.equal(report.targets.find((t) => t.source === "treasury").inCursor, false);
});

test("identity: a positioned cursor target with no archived records is reported", () => {
  const report = checkCursorConsistency(CLEAN_CURSOR, CLEAN_ARCHIVE.filter((e) => e.source === "market"));
  assert.deepEqual(kinds(report), ["warning:cursor-target-unarchived:squad"]);
  assert.equal(report.consistent, true);
});

test("identity: mixed contract ids for one target and a configured-contract mismatch are errors", () => {
  const report = checkCursorConsistency(
    CLEAN_CURSOR,
    [ev("market", MARKET, 100), ev("market", MARKET, 105), ev("market", OTHER, 110), ev("squad", SQUAD, 102), ev("squad", SQUAD, 108)],
    { expectedContracts: { market: MARKET, squad: SQUAD } },
  );
  assert.equal(report.consistent, false);
  assert.deepEqual(kinds(report), ["error:mixed-contract-ids:market", "error:contract-mismatch:market"]);
  assert.equal(find(report, "mixed-contract-ids").count, 2);
  assert.deepEqual(report.targets[0].archive.contractIds, [MARKET, OTHER].sort());

  // Without a configured id only the archive's self-consistency is checked.
  const unconfigured = checkCursorConsistency(CLEAN_CURSOR, [ev("market", OTHER, 100), ev("market", OTHER, 105), ev("market", OTHER, 110), ev("squad", SQUAD, 102), ev("squad", SQUAD, 108)]);
  assert.equal(unconfigured.consistent, true);
  const configured = checkCursorConsistency(CLEAN_CURSOR, [ev("market", OTHER, 100), ev("market", OTHER, 105), ev("market", OTHER, 110), ev("squad", SQUAD, 102), ev("squad", SQUAD, 108)], {
    expectedContracts: { market: MARKET },
  });
  assert.deepEqual(kinds(configured), ["error:contract-mismatch:market"]);
});

test("ranges: an archive that stops before the cursor's last event is a gap", () => {
  const report = checkCursorConsistency(CLEAN_CURSOR, CLEAN_ARCHIVE.filter((e) => e.ledger !== 110));
  const gap = find(report, "archive-behind-cursor", "market");
  assert.equal(gap.severity, "error");
  assert.equal(gap.firstLedger, 106);
  assert.equal(gap.lastLedger, 110);
  assert.equal(gap.count, 1);
  assert.equal(report.consistent, false);
});

test("ranges: archive events past the cursor position are a contradiction (boundary at position + 1)", () => {
  // Exactly at the cursor's position: consistent.
  assert.equal(checkCursorConsistency(CLEAN_CURSOR, CLEAN_ARCHIVE).consistent, true);

  const report = checkCursorConsistency(CLEAN_CURSOR, [...CLEAN_ARCHIVE, ev("market", MARKET, 111), ev("market", MARKET, 120)]);
  const beyond = find(report, "archive-beyond-cursor", "market");
  assert.equal(beyond.severity, "error");
  assert.equal(beyond.count, 2);
  assert.equal(beyond.firstLedger, 111);
  assert.equal(beyond.lastLedger, 120);
  assert.match(beyond.message, /past the cursor's position at ledger 110/);
});

test("ranges: a resume cursor past the last event (idle at tip) is not a contradiction", () => {
  const cursor = cursorFile({
    market: target(110, [tok(100), tok(105), tok(110)], 150),
    squad: target(108, [tok(102), tok(108)], 150),
  });
  const report = checkCursorConsistency(cursor, CLEAN_ARCHIVE);
  assert.deepEqual(report.findings, []);
});

test("gaps: processed event ids missing inside the archived span are reported; older ids are not", () => {
  const cursor = cursorFile({
    market: target(110, [tok(90), tok(100), tok(103), tok(105), tok(110)]),
    squad: CLEAN_CURSOR.targets.squad,
  });
  const report = checkCursorConsistency(cursor, CLEAN_ARCHIVE);
  assert.deepEqual(kinds(report), ["error:processed-events-missing:market"]);
  const missing = find(report, "processed-events-missing");
  assert.equal(missing.count, 1);
  assert.equal(missing.firstLedger, 103);

  // Boundary: a processed id exactly at the archive's first ledger counts.
  const atStart = cursorFile({
    market: target(110, [tok(100, 7), tok(110)]),
    squad: CLEAN_CURSOR.targets.squad,
  });
  assert.equal(find(checkCursorConsistency(atStart, CLEAN_ARCHIVE), "processed-events-missing").firstLedger, 100);
});

test("contradictions inside the archive: ledger vs event id, conflicting and exact duplicates, order", () => {
  const archive = [
    ev("market", MARKET, 100),
    { ...ev("market", MARKET, 105), ledger: 104 }, // event id packs 105
    ev("market", MARKET, 100), // exact duplicate
    { ...ev("market", MARKET, 110), txHash: "f".repeat(64) },
    { ...ev("market", MARKET, 110), txHash: "e".repeat(64) }, // same id, different tx
    ev("market", MARKET, 103), // appears after 110 on disk
    ev("squad", SQUAD, 102),
    ev("squad", SQUAD, 108),
  ];
  const cursor = cursorFile({ market: target(110, []), squad: target(108, []) });
  const report = checkCursorConsistency(cursor, archive);
  assert.deepEqual(kinds(report), [
    "error:event-ledger-mismatch:market",
    "error:conflicting-duplicate:market",
    "warning:duplicate-event:market",
    "warning:out-of-order:market",
  ]);
  assert.equal(find(report, "event-ledger-mismatch").firstRecord, 2);
  assert.equal(find(report, "duplicate-event").firstRecord, 3);
  assert.equal(find(report, "conflicting-duplicate").firstRecord, 5);
  assert.equal(find(report, "out-of-order").firstRecord, 6);
});

test("malformed archive records are counted, not trusted, and fail the check", () => {
  const report = checkCursorConsistency(CLEAN_CURSOR, [
    ...CLEAN_ARCHIVE,
    null,
    "not-an-event",
    { ...ev("market", MARKET, 111), ledger: 0 },
    { ...ev("market", MARKET, 112), eventId: "" },
    { source: "market" },
  ]);
  const malformed = find(report, "malformed-record");
  assert.equal(malformed.source, null);
  assert.equal(malformed.count, 5);
  assert.equal(malformed.firstRecord, 6);
  assert.equal(report.records, 10);
  assert.equal(report.consistent, false);
  // Malformed records never extend a target's observed range.
  assert.equal(report.targets[0].archive.lastLedger, 110);
});

test("cursor contradictions: resume cursor behind its own last event ledger; unreadable and cold cursors", () => {
  const behind = cursorFile({ market: target(110, [], 105), squad: CLEAN_CURSOR.targets.squad });
  const report = checkCursorConsistency(behind, CLEAN_ARCHIVE);
  const contradiction = find(report, "cursor-ledger-contradiction", "market");
  assert.equal(contradiction.severity, "error");
  assert.equal(contradiction.firstLedger, 105);
  assert.equal(contradiction.lastLedger, 110);

  const unreadable = cursorFile({
    market: { cursor: "opaque-token", lastEventLedger: 110, recentEventIds: [] },
    squad: CLEAN_CURSOR.targets.squad,
  });
  const unreadableReport = checkCursorConsistency(unreadable, CLEAN_ARCHIVE);
  assert.deepEqual(kinds(unreadableReport), ["warning:cursor-unreadable:market"]);
  assert.equal(unreadableReport.targets[0].cursorLedger, null);

  const cold = cursorFile({ market: { cursor: null, lastEventLedger: null }, squad: CLEAN_CURSOR.targets.squad });
  assert.deepEqual(kinds(checkCursorConsistency(cold, CLEAN_ARCHIVE)), ["warning:cursor-unpositioned:market"]);
});

test("rewinds: archived events past the floor are expected; recorded floor-rewind gaps are surfaced", () => {
  const cursor = cursorFile(
    {
      market: { cursor: null, lastEventLedger: null, rewindFromLedger: 104 },
      squad: CLEAN_CURSOR.targets.squad,
    },
    {
      recoveryHistory: [
        {
          at: "2026-11-21T07:00:00.000Z",
          reason: "floor_rewind",
          source: "market",
          before: { market: { cursor: tok(90, 1), lastEventLedger: 90 } },
          after: { market: { cursor: null, lastEventLedger: null, rewindFromLedger: 104 } },
        },
        {
          at: "2026-11-21T07:30:00.000Z",
          reason: "restore",
          before: {},
          after: { market: { cursor: tok(90, 1), lastEventLedger: 90 } },
        },
      ],
    },
  );
  const report = checkCursorConsistency(cursor, CLEAN_ARCHIVE);
  assert.equal(report.consistent, true);
  assert.deepEqual(kinds(report), ["warning:rewind-pending:market", "warning:recorded-gap:market"]);
  const gap = find(report, "recorded-gap");
  assert.equal(gap.firstLedger, 91);
  assert.equal(gap.lastLedger, 103);
});

test("the text report prints ledgers and counts but no cursor tokens or event ids", () => {
  const report = checkCursorConsistency(CLEAN_CURSOR, [...CLEAN_ARCHIVE, ev("market", MARKET, 120)]);
  const text = formatCursorConsistencyReport(report);
  assert.match(text, /INCONSISTENT \(1 error, 0 warnings, 6 archive records\)/);
  assert.match(text, /ERROR archive-beyond-cursor \[market\] x1 \(ledgers 111-120\)/);
  assert.match(text, /read-only: no cursor or archive was modified/);
  assert.doesNotMatch(text, /\d{19}-\d{10}/);
});

// ── CLI (read-only on disk) ─────────────────────────────────────────────────

async function writeArchiveDir(dir, events) {
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "events-2026-11-21T08-00-00-000Z-000001.jsonl"),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
}

async function fingerprint(root) {
  const out = {};
  async function walk(dir) {
    for (const name of (await readdir(dir)).sort()) {
      const full = path.join(dir, name);
      const info = await stat(full);
      if (info.isDirectory()) {
        await walk(full);
      } else {
        out[path.relative(root, full)] = {
          sha256: createHash("sha256").update(await readFile(full)).digest("hex"),
          mtimeMs: info.mtimeMs,
          mode: info.mode,
        };
      }
    }
  }
  await walk(root);
  return out;
}

function runCli(args, cwd) {
  const env = { ...process.env, DOTENV_CONFIG_PATH: path.join(cwd, "missing.env") };
  delete env.CURSOR_FILE;
  delete env.MARKET_CONTRACT_ID;
  delete env.SQUAD_CONTRACT_ID;
  return execFileAsync(process.execPath, [CLI, ...args], { cwd, env }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (err) => ({ code: err.code, stdout: err.stdout, stderr: err.stderr }),
  );
}

test("checkCursor reads an archive directory and leaves every file byte- and mtime-identical", async () => {
  await withTempDataDir(async (data) => {
    const cursorPath = data.file("cursor.json");
    await writeFile(cursorPath, `${JSON.stringify(CLEAN_CURSOR, null, 2)}\n`);
    await writeArchiveDir(data.file("archive"), [...CLEAN_ARCHIVE, ev("market", MARKET, 130)]);
    const before = await fingerprint(data.root);

    const report = await checkCursor({ cursorFile: cursorPath, archivePath: data.file("archive") });
    assert.equal(report.consistent, false);
    assert.equal(find(report, "archive-beyond-cursor").lastLedger, 130);

    // No lock file, no temp file, no rewritten cursor or archive.
    assert.deepEqual(await fingerprint(data.root), before);
  }, "mimir-cursor-check-");
});

test("scan JSONL exports are accepted and their summary line is ignored", async () => {
  await withTempDataDir(async (data) => {
    const jsonl =
      CLEAN_ARCHIVE.map((e) => JSON.stringify({ type: "event", ...e })).join("\n") +
      `\n${JSON.stringify({ type: "summary", eventCount: 5, histogram: {} })}\n`;
    await writeFile(data.file("scan.jsonl"), jsonl);
    const records = await readScanArchiveRecords(data.file("scan.jsonl"));
    assert.equal(records.length, 5);
    assert.equal("type" in records[0], false);
    assert.equal(checkCursorConsistency(CLEAN_CURSOR, records).consistent, true);

    await writeFile(data.file("broken.jsonl"), `${JSON.stringify(CLEAN_ARCHIVE[0])}\n{not json\n`);
    await assert.rejects(readScanArchiveRecords(data.file("broken.jsonl")), /malformed archive record at line 2/);
    await assert.rejects(readScanArchiveRecords(data.file("nope")), /archive not found/);
  }, "mimir-cursor-check-");
});

test("checkCursor rejects a malformed cursor file without touching it", async () => {
  await withTempDataDir(async (data) => {
    await writeFile(data.file("cursor.json"), "{ not json");
    await writeArchiveDir(data.file("archive"), CLEAN_ARCHIVE);
    const before = await fingerprint(data.root);
    await assert.rejects(
      checkCursor({ cursorFile: data.file("cursor.json"), archivePath: data.file("archive") }),
      /cursor file is malformed or uses an unsupported schema/,
    );
    assert.deepEqual(await fingerprint(data.root), before);
  }, "mimir-cursor-check-");
});

test("`cursor check` exits 0 when consistent and 1 with findings, writing nothing", async () => {
  await withTempDataDir(async (data) => {
    await writeFile(data.file("cursor.json"), `${JSON.stringify(CLEAN_CURSOR, null, 2)}\n`);
    await writeArchiveDir(data.file("clean"), CLEAN_ARCHIVE);
    await writeArchiveDir(data.file("drifted"), [...CLEAN_ARCHIVE.filter((e) => e.ledger !== 105), ev("market", OTHER, 111)]);
    const before = await fingerprint(data.root);

    const ok = await runCli(["check", "--file", "cursor.json", "--archive", "clean"], data.root);
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /consistency check: consistent \(0 errors, 0 warnings, 5 archive records\)/);

    const bad = await runCli(
      ["check", "--file", "cursor.json", "--archive", "drifted", "--market-contract", MARKET],
      data.root,
    );
    assert.equal(bad.code, 1);
    assert.match(bad.stdout, /ERROR mixed-contract-ids \[market\]/);
    assert.match(bad.stdout, /ERROR contract-mismatch \[market\]/);
    assert.match(bad.stdout, /ERROR archive-beyond-cursor \[market\] x1 \(ledger 111\)/);
    assert.match(bad.stdout, /ERROR processed-events-missing \[market\] x1 \(ledger 105\)/);
    assert.doesNotMatch(bad.stdout, /\d{19}-\d{10}/);

    const json = await runCli(["check", "--file", "cursor.json", "--archive", "drifted", "--json"], data.root);
    assert.equal(json.code, 1);
    const parsed = JSON.parse(json.stdout);
    assert.equal(parsed.consistent, false);
    assert.deepEqual(
      parsed.findings.map((f) => f.kind),
      ["mixed-contract-ids", "archive-beyond-cursor", "processed-events-missing"],
    );

    assert.deepEqual(await fingerprint(data.root), before);
  }, "mimir-cursor-check-");
});

test("`cursor check` usage errors and the updated usage line", async () => {
  await withTempDataDir(async (data) => {
    await writeFile(data.file("cursor.json"), `${JSON.stringify(CLEAN_CURSOR)}\n`);
    const noArchive = await runCli(["check", "--file", "cursor.json"], data.root);
    assert.equal(noArchive.code, 1);
    assert.match(noArchive.stderr, /check requires --archive PATH/);

    const missing = await runCli(["check", "--file", "cursor.json", "--archive", "nope"], data.root);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /archive not found/);

    const dup = await runCli(["check", "--archive", "a", "--archive", "b"], data.root);
    assert.equal(dup.code, 1);
    assert.match(dup.stderr, /duplicate --archive option/);

    const noId = await runCli(["check", "--archive", "a", "--market-contract"], data.root);
    assert.match(noId.stderr, /--market-contract requires a contract id/);

    const usage = await runCli(["verify"], data.root);
    assert.equal(usage.code, 1);
    assert.match(usage.stderr, /<backup\|restore\|history\|preview\|check>/);
  }, "mimir-cursor-check-");
});
