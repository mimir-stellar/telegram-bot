import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildSupportBundle,
  collectSupportBundle,
  serializeSupportBundle,
  SUPPORT_BUNDLE_SCHEMA_VERSION,
} from "../dist/support-bundle.js";

const SECRET_TOKEN = ["1234567890:", "AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"].join("");
const SECRET_SEED = ["S", "A".repeat(55)].join("");
const VALID_MARKET_ID = "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";
const VALID_SQUAD_ID = "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY";

function healthFixture() {
  return {
    ok: false,
    status: "degraded",
    service: "mimir-telegram-bot",
    version: "0.1.0",
    network: "testnet",
    uptimeMs: 1234,
    checkedAt: "2026-11-18T00:00:00.000Z",
    poller: {
      running: true,
      paused: false,
      stopping: false,
      cycles: 9,
      latestLedger: 100,
      oldestLedger: 1,
      consecutiveFailures: 2,
      notificationsSent: 4,
      notificationsFailed: 1,
      eventsSkipped: 0,
      notificationsDropped: 0,
      deadLetter: { depth: 1, enqueued: 2, replayed: 1, dropped: 0 },
      lastError: {
        at: "2026-11-18T00:00:00.000Z",
        message: `RPC rejected authorisation token=${SECRET_TOKEN} seed=${SECRET_SEED} ${"x".repeat(600)}`,
      },
      targets: [
        {
          source: "market",
          version: "v1",
          contractId: VALID_MARKET_ID,
          lastEventLedger: 99,
          cursorStale: false,
          cursorStalled: false,
          hasError: true,
        },
      ],
    },
    config: { BOT_TOKEN: "source:env", TELEGRAM_CHAT_ID: "source:env" },
  };
}

test("buildSupportBundle collects schema versions, health and bounded errors", () => {
  const bundle = buildSupportBundle({
    now: Date.UTC(2026, 10, 18),
    packageInfo: { name: "@mimir-stellar/telegram-bot", version: "0.1.0" },
    runtime: { node: "v20.18.0", platform: "linux", arch: "x64" },
    health: healthFixture(),
    status: {
      schemaVersion: 1,
      generatedAt: "2026-11-18T00:00:00.000Z",
      running: true,
      network: "testnet",
      cycles: 9,
      lastError: { at: 0, message: `failure ${SECRET_TOKEN}` },
    },
  });

  assert.equal(bundle.schemaVersion, SUPPORT_BUNDLE_SCHEMA_VERSION);
  assert.equal(bundle.schemas.status.expected, 1);
  assert.equal(bundle.schemas.cursor.expected, 1);
  assert.equal(bundle.schemas.counters.expected, 1);
  assert.equal(bundle.schemas.health.present, true);
  assert.equal(bundle.health.status, "degraded");
  assert.equal(bundle.health.poller.consecutiveFailures, 2);
  assert.equal(bundle.health.poller.targets[0].contractId, VALID_MARKET_ID);
  assert.equal(bundle.errors.length >= 2, true);

  const serialized = serializeSupportBundle(bundle);
  assert.equal(serialized.includes(SECRET_TOKEN), false, "bot token must be redacted");
  assert.equal(serialized.includes(SECRET_SEED), false, "seed must be redacted");
  assert.equal(Buffer.byteLength(serialized) < 20_000, true, "bundle stays bounded");
  for (const error of bundle.errors) {
    assert.equal(error.message.length <= 300, true, `error ${error.kind} must be bounded`);
  }
});

test("buildSupportBundle does not dump arbitrary environment or private config", () => {
  const bundle = buildSupportBundle({
    health: {
      ...healthFixture(),
      config: { BOT_TOKEN: SECRET_TOKEN, TELEGRAM_CHAT_ID: "-1001999999999" },
    },
    status: {
      schemaVersion: 1,
      running: true,
      network: "testnet",
      chatId: "-1001999999999",
      rpcUrl: `https://user:${SECRET_TOKEN}@rpc.example`,
    },
  });
  const serialized = serializeSupportBundle(bundle);
  assert.equal(serialized.includes(SECRET_TOKEN), false);
  assert.equal(serialized.includes("-1001999999999"), false);
  assert.equal(Object.hasOwn(bundle, "env"), false);
  assert.equal(Object.hasOwn(bundle.health, "config"), false);
});

test("collectSupportBundle reads local schema versions and records unreadable files", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mimir-support-bundle-"));
  try {
    await writeFile(
      path.join(dir, ".env"),
      [
        `MARKET_CONTRACT_ID=${VALID_MARKET_ID}`,
        `SQUAD_CONTRACT_ID=${VALID_SQUAD_ID}`,
        `BOT_TOKEN=${SECRET_TOKEN}`,
        "TELEGRAM_CHAT_ID=-1001234567890",
      ].join("\n"),
    );
    await writeFile(
      path.join(dir, "status.json"),
      JSON.stringify({ schemaVersion: 1, running: true, lastError: { at: 0, message: SECRET_TOKEN } }),
    );
    await writeFile(path.join(dir, "cursor.json"), JSON.stringify({ version: 1, targets: {} }));
    await writeFile(path.join(dir, "counters.json"), "{not json");

    const bundle = await collectSupportBundle({
      cwd: dir,
      env: {
        MARKET_CONTRACT_ID: VALID_MARKET_ID,
        SQUAD_CONTRACT_ID: VALID_SQUAD_ID,
        BOT_TOKEN: SECRET_TOKEN,
        TELEGRAM_CHAT_ID: "-1001234567890",
      },
      nodeVersion: "v20.18.0",
      packageJsonPath: path.resolve("package.json"),
      statusPath: path.join(dir, "status.json"),
      cursorPath: path.join(dir, "cursor.json"),
      countersPath: path.join(dir, "counters.json"),
      healthUrl: null,
      now: Date.UTC(2026, 10, 18),
    });

    assert.equal(bundle.schemas.status.present, true);
    assert.equal(bundle.schemas.status.version, 1);
    assert.equal(bundle.schemas.cursor.version, 1);
    assert.equal(bundle.schemas.counters.present, true);
    assert.match(bundle.schemas.counters.error ?? "", /JSON|Unexpected|not valid/i);
    assert.equal(bundle.doctor.ok, true);
    assert.equal(serializeSupportBundle(bundle).includes(SECRET_TOKEN), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
