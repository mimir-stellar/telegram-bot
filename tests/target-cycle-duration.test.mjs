import assert from "node:assert/strict";
import test from "node:test";

import { rpc } from "@stellar/stellar-sdk";

import { buildHealthReport } from "../dist/health.js";
import { createPoller } from "../dist/poller.js";
import {
  MOCK_BOT_TOKEN,
  MOCK_MARKET_CONTRACT_ID,
  MOCK_NETWORK_PASSPHRASE,
  MOCK_SQUAD_CONTRACT_ID,
} from "../dist/stellar/mock-constants.js";
import { startMockRpc } from "../dist/stellar/mock-rpc.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

const CAPTAIN = "GCLJONJVCLJGE6CSMCHCGYA563ADTCK5YGF3KERDMSNS3MNNDAIXHFA5";

function config(cursorFile, rpcUrl) {
  return {
    version: "0.1.0",
    marketContractId: MOCK_MARKET_CONTRACT_ID,
    squadContractId: MOCK_SQUAD_CONTRACT_ID,
    rpcUrl,
    horizonUrl: "https://example.invalid/horizon",
    networkPassphrase: MOCK_NETWORK_PASSPHRASE,
    explorerBaseUrl: "https://example.invalid/explorer",
    botToken: MOCK_BOT_TOKEN,
    chatId: "-1001234567890",
    operatorTelegramUserId: null,
    pollIntervalMs: 30_000,
    startLookbackLedgers: 9,
    cursorFile,
    maxNotificationsPerCycle: 20,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
  };
}

function bySource(targets) {
  return Object.fromEntries(targets.map((target) => [target.source, target]));
}

test("target cycle durations use the injected clock, retain maxima, and reset on restart", async () => {
  await withTempDataDir(async (dataDir) => {
    const mock = await startMockRpc({
      port: 0,
      scenario: {
        latestLedger: 10,
        oldestLedger: 1,
        ledgersPerPage: 50,
        events: [
          {
            source: "market",
            ledger: 9,
            eventName: "claim_created",
            topics: [3, { address: CAPTAIN }],
            fields: { category: "sports" },
          },
          {
            source: "squad",
            ledger: 10,
            eventName: "market_created",
            topics: [5, { address: CAPTAIN }],
            fields: {
              deadline: 1_893_456_000,
              fee_bps: 100,
              question: "Will target timing include delivery?",
            },
          },
        ],
      },
    });

    try {
      let clock = 1_000;
      let cycle = 0;
      const advances = [
        { health: 5, market: 20, squad: 13, marketSend: 7, squadSend: 6 },
        { health: 2, market: 3, squad: 4, marketSend: 0, squadSend: 0 },
      ];
      const now = () => clock;
      const server = new rpc.Server(mock.url, { allowHttp: true });
      const getHealth = server.getHealth.bind(server);
      const getEvents = server.getEvents.bind(server);

      server.getHealth = async (...args) => {
        const result = await getHealth(...args);
        clock += advances[cycle].health;
        return result;
      };
      server.getEvents = async (...args) => {
        const result = await getEvents(...args);
        const contractId = args[0]?.filters?.[0]?.contractIds?.[0];
        const source = contractId === MOCK_SQUAD_CONTRACT_ID ? "squad" : "market";
        clock += advances[cycle][source];
        return result;
      };

      const cursorFile = dataDir.file("cursor.json");
      const pollerConfig = config(cursorFile, mock.url);
      const poller = createPoller({
        config: pollerConfig,
        server,
        now,
        sleep: async () => {},
        sendOptions: { sendSpacingMs: 0 },
        persistAudit: false,
        send: async (_text, source) => {
          clock += advances[cycle][`${source}Send`];
        },
      });

      await poller.cycle();
      let targets = bySource(poller.status().targets);
      assert.deepEqual(
        {
          market: [targets.market.lastCycleMs, targets.market.maxCycleMs],
          squad: [targets.squad.lastCycleMs, targets.squad.maxCycleMs],
        },
        { market: [32, 32], squad: [19, 19] },
      );

      cycle = 1;
      await poller.cycle();
      targets = bySource(poller.status().targets);
      assert.deepEqual(
        {
          market: [targets.market.lastCycleMs, targets.market.maxCycleMs],
          squad: [targets.squad.lastCycleMs, targets.squad.maxCycleMs],
        },
        { market: [5, 32], squad: [4, 19] },
      );

      const healthTargets = bySource(buildHealthReport(pollerConfig, poller.status(), clock).poller.targets);
      const snapshotTargets = bySource(poller.snapshot().targets);
      for (const source of ["market", "squad"]) {
        assert.equal(healthTargets[source].lastCycleMs, targets[source].lastCycleMs);
        assert.equal(healthTargets[source].maxCycleMs, targets[source].maxCycleMs);
        assert.equal(snapshotTargets[source].lastCycleMs, targets[source].lastCycleMs);
        assert.equal(snapshotTargets[source].maxCycleMs, targets[source].maxCycleMs);
      }

      const restarted = createPoller({
        config: pollerConfig,
        server: new rpc.Server(mock.url, { allowHttp: true }),
        now,
        sleep: async () => {},
        sendOptions: { sendSpacingMs: 0 },
        persistAudit: false,
        send: async () => {},
      });
      await restarted.loadCursors();
      for (const target of restarted.status().targets) {
        assert.equal(target.lastCycleMs, 0);
        assert.equal(target.maxCycleMs, 0);
      }
    } finally {
      await mock.close();
    }
  }, "mimir-target-cycle-duration-");
});
