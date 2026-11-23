import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  buildScanJsonReport,
  buildScanJsonTarget,
  readContractEvents,
} from "../dist/stellar/events.js";
import { startMockRpc } from "../dist/stellar/mock-rpc.js";
import {
  DEFAULT_MARKDOWN_MAX_ROWS,
  escapeMarkdownCell,
  formatScanMarkdown,
  shortTxHash,
} from "../dist/stellar/scan-markdown.js";
import {
  CAPTAIN,
  CHALL,
  CREATOR,
  MARKET_CONTRACT,
  SQUAD_CONTRACT,
  claimChallengedEvent,
  claimCreatedEvent,
  claimResolvedEvent,
  emptyTopicsEvent,
  marketSettledEvent,
  squadDepositedEvent,
  squadMarketCreatedEvent,
} from "./fixtures/events.mjs";

const execFileAsync = promisify(execFile);
const EVENTS_CLI = fileURLToPath(new URL("../dist/stellar/events.js", import.meta.url));

function makeCursor(ledger, index = 0) {
  const toid = BigInt(ledger) << 32n;
  return `${toid}-${index}`;
}

function createFixtureServer(events, { oldestLedger = 100, latestLedger = 500 } = {}) {
  return {
    async getHealth() {
      return { status: "healthy", oldestLedger, latestLedger };
    },
    async getEvents() {
      return {
        events,
        cursor: makeCursor(latestLedger),
        latestLedger,
      };
    },
  };
}

/**
 * Verify that `markdown` is a valid GitHub-flavoured Markdown table:
 * - ends with a trailing newline
 * - has at least header + separator rows
 * - every row starts and ends with `|` and has the exact same number of unescaped columns (5)
 */
function assertValidGfmTable(markdown, expectedColumns = 5) {
  assert.equal(markdown.endsWith("\n"), true, "table output must end with a newline");
  const lines = markdown.trimEnd().split("\n");
  assert.ok(lines.length >= 2, "table must contain at least header and delimiter rows");

  for (const [idx, line] of lines.entries()) {
    assert.ok(line.startsWith("|") && line.endsWith("|"), `row ${idx} must be enclosed in pipes`);
    // Count unescaped pipes: replace escaped \| with a placeholder first
    const withoutEscapedPipes = line.replace(/\\\|/g, "__ESCAPED_PIPE__");
    const pipes = withoutEscapedPipes.split("|").length - 1;
    assert.equal(
      pipes,
      expectedColumns + 1,
      `row ${idx} must have ${expectedColumns} columns (${expectedColumns + 1} unescaped pipes), got ${pipes}: ${line}`,
    );
  }

  // Delimiter row cells must all be `---`
  const delimiterCells = lines[1]
    .slice(1, -1)
    .split("|")
    .map((c) => c.trim());
  assert.deepEqual(
    delimiterCells,
    Array.from({ length: expectedColumns }, () => "---"),
    "second row must be a valid GFM delimiter row",
  );

  return lines;
}

test("snapshot: formatScanMarkdown renders a report built from tests/fixtures/events.mjs", async () => {
  const marketRaw = [
    claimCreatedEvent({ id: makeCursor(101, 0), ledger: 101 }),
    claimChallengedEvent({ id: makeCursor(102, 0), ledger: 102, stake: 25_000_000n }),
    claimResolvedEvent({ id: makeCursor(103, 0), ledger: 103 }),
    marketSettledEvent({ id: makeCursor(104, 0), ledger: 104 }),
    emptyTopicsEvent({ id: makeCursor(105, 0), ledger: 105 }),
  ];

  const squadRaw = [
    squadMarketCreatedEvent({ id: makeCursor(201, 0), ledger: 201 }),
    squadDepositedEvent({ id: makeCursor(202, 0), ledger: 202 }),
  ];

  const marketScan = await readContractEvents(
    createFixtureServer(marketRaw),
    { source: "market", contractId: MARKET_CONTRACT },
    { startLedger: 100 },
  );
  const squadScan = await readContractEvents(
    createFixtureServer(squadRaw),
    { source: "squad", contractId: SQUAD_CONTRACT },
    { startLedger: 100 },
  );

  const report = buildScanJsonReport({
    network: "testnet",
    rpcUrl: "https://soroban-testnet.stellar.org",
    oldestLedger: 100,
    latestLedger: 500,
    targets: [
      buildScanJsonTarget(marketScan, 20),
      buildScanJsonTarget(squadScan, 20),
    ],
  });

  const table = formatScanMarkdown(report);
  const lines = assertValidGfmTable(table);
  assert.equal(lines.length, 2 + 7);

  const expected = [
    "| Source | Ledger | Event | Tx | Summary |",
    "| --- | --- | --- | --- | --- |",
    `| market | 101 | claim_created | aabbcc00…1122 | {"category":"crypto","claimId":7,"creator":"${CREATOR}","name":"claim_created"} |`,
    `| market | 102 | claim_challenged | aabbcc00…1122 | {"challenger":"${CHALL}","claimId":7,"name":"claim_challenged","stake":"25000000"} |`,
    `| market | 103 | claim_resolved | aabbcc00…1122 | {"claimId":7,"confidence":100,"evidenceHash":"deadbeefcafebabe00112233445566778899aabbccddeeff0011223344556677","name":"claim_resolved","summary":"Onchain smoke — challengers awarded so the payout pull can be exercised","winnerSide":2} |`,
    `| market | 104 | market_settled | aabbcc00…1122 | {"claimId":7,"dust":"0","name":"market_settled","owedToChallengers":"38000000","totalFees":"2000000","totalPaid":"40000000"} |`,
    `| market | 105 | unknown:? | aabbcc00…1122 | {"eventName":"","name":"unknown","reason":"empty topic array"} |`,
    `| squad | 201 | market_created | aabbcc00…1122 | {"captain":"${CAPTAIN}","deadline":1800000000,"feeBps":200,"marketId":1,"name":"market_created","question":"Will BTC exceed $100k by end of 2026?"} |`,
    `| squad | 202 | deposited | aabbcc00…1122 | {"amount":"50000000","marketId":1,"name":"deposited","participant":"${CREATOR}","shares":"50000000","side":1} |`,
    "",
  ].join("\n");

  assert.equal(table, expected);
});

test("formatScanMarkdown escapes pipe characters in cell text so GFM column alignment holds", async () => {
  const rawEvents = [
    claimCreatedEvent({
      id: makeCursor(110, 0),
      ledger: 110,
      category: "crypto | macro | defi",
    }),
    squadMarketCreatedEvent({
      id: makeCursor(111, 0),
      ledger: 111,
      question: "Option A | Option B | Option C?",
    }),
  ];

  const marketScan = await readContractEvents(
    createFixtureServer([rawEvents[0]]),
    { source: "market", contractId: MARKET_CONTRACT },
    { startLedger: 100 },
  );
  const squadScan = await readContractEvents(
    createFixtureServer([rawEvents[1]]),
    { source: "squad", contractId: SQUAD_CONTRACT },
    { startLedger: 100 },
  );

  const report = buildScanJsonReport({
    network: "testnet",
    rpcUrl: "https://soroban-testnet.stellar.org",
    oldestLedger: 100,
    latestLedger: 500,
    targets: [
      buildScanJsonTarget(marketScan, 10),
      buildScanJsonTarget(squadScan, 10),
    ],
  });

  const table = formatScanMarkdown(report);
  assertValidGfmTable(table);
  assert.ok(table.includes("crypto \\| macro \\| defi"), "pipes in category must be escaped");
  assert.ok(
    table.includes("Option A \\| Option B \\| Option C?"),
    "pipes in question must be escaped",
  );
  assert.equal(escapeMarkdownCell("a | b\nc | d"), "a \\| b c \\| d");
});

test("formatScanMarkdown caps large reports with a trailing 'N more' row", async () => {
  const totalCount = DEFAULT_MARKDOWN_MAX_ROWS + 12;
  const rawEvents = Array.from({ length: totalCount }, (_, i) =>
    claimCreatedEvent({
      id: makeCursor(100 + i, 0),
      ledger: 100 + i,
      claimId: i + 1,
    }),
  );

  const scan = await readContractEvents(
    createFixtureServer(rawEvents, { oldestLedger: 100, latestLedger: 500 }),
    { source: "market", contractId: MARKET_CONTRACT },
    { startLedger: 100 },
  );

  const report = buildScanJsonReport({
    network: "testnet",
    rpcUrl: "https://soroban-testnet.stellar.org",
    oldestLedger: 100,
    latestLedger: 500,
    targets: [buildScanJsonTarget(scan, totalCount)],
  });

  // 1) Default cap (DEFAULT_MARKDOWN_MAX_ROWS = 50)
  const defaultCapped = formatScanMarkdown(report);
  const defaultLines = assertValidGfmTable(defaultCapped);
  assert.equal(defaultLines.length, 2 + DEFAULT_MARKDOWN_MAX_ROWS + 1);
  assert.equal(defaultLines[defaultLines.length - 1], "| … | | | | 12 more |");

  // 2) Custom maxRows option
  const customCapped = formatScanMarkdown(report, { maxRows: 3 });
  const customLines = assertValidGfmTable(customCapped);
  assert.equal(customLines.length, 2 + 3 + 1);
  assert.equal(
    customLines[customLines.length - 1],
    `| … | | | | ${totalCount - 3} more |`,
  );

  // 3) Target already truncated via buildScanJsonTarget(scan, show)
  const preTruncatedReport = buildScanJsonReport({
    network: "testnet",
    rpcUrl: "https://soroban-testnet.stellar.org",
    oldestLedger: 100,
    latestLedger: 500,
    targets: [buildScanJsonTarget(scan, 4)],
  });
  const preTruncatedTable = formatScanMarkdown(preTruncatedReport);
  const preTruncatedLines = assertValidGfmTable(preTruncatedTable);
  assert.equal(preTruncatedLines.length, 2 + 4 + 1);
  assert.equal(
    preTruncatedLines[preTruncatedLines.length - 1],
    `| … | | | | ${totalCount - 4} more |`,
  );
});

test("formatScanMarkdown handles empty reports and shortTxHash edge cases", () => {
  const emptyReport = buildScanJsonReport({
    network: "testnet",
    rpcUrl: "https://soroban-testnet.stellar.org",
    oldestLedger: 100,
    latestLedger: 500,
    targets: [],
  });

  const table = formatScanMarkdown(emptyReport);
  const lines = assertValidGfmTable(table);
  assert.equal(lines.length, 2);
  assert.equal(
    table,
    ["| Source | Ledger | Event | Tx | Summary |", "| --- | --- | --- | --- | --- |", ""].join(
      "\n",
    ),
  );

  assert.equal(shortTxHash(""), "");
  assert.equal(shortTxHash("deadbeef"), "deadbeef");
  assert.equal(
    shortTxHash("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"),
    "01234567…cdef",
  );
});

test("scanner CLI --markdown writes a valid GFM table to stdout and sends progress to stderr", async () => {
  const mock = await startMockRpc({ port: 0 });
  try {
    const env = { ...process.env, STELLAR_RPC_URL: mock.url };
    delete env.MIMIR_PROFILE;

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [EVENTS_CLI, "--mock", "--markdown", "--pages", "5"],
      { env, timeout: 15000, maxBuffer: 4 * 1024 * 1024 },
    );

    assert.ok(stderr.includes("scanning mock ledgers"), "progress must go to stderr");
    assert.ok(stderr.includes("scanned market:"), "target progress must go to stderr");

    const lines = assertValidGfmTable(stdout);
    assert.ok(lines.length >= 3, "must emit header, delimiter, and event rows");
    assert.equal(lines[0], "| Source | Ledger | Event | Tx | Summary |");
  } finally {
    await mock.close();
  }
});
