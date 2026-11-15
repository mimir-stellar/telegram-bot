import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { ConfigError, loadStellarConfig } from "../dist/config.js";
import { createPoller } from "../dist/poller.js";
import {
  DEFAULT_RPC_MAX_RESPONSE_BYTES,
  RpcResponseByteLimitError,
  createRpcServer,
  readBoundedRpcJson,
} from "../dist/stellar/client.js";
import { paginatedGetEvents } from "../dist/stellar/events.js";
import { RpcResponseShapeError } from "../dist/stellar/rpc-guard.js";
import { createTempDataDir } from "./helpers/temp-data.mjs";

const MARKET_ID = "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";
const SQUAD_ID = "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY";

function makeCursor(ledger, tx = 1) {
  const toid = (BigInt(ledger) << 32n) | BigInt(tx);
  return `${toid}-0`;
}

describe("readBoundedRpcJson (#804)", () => {
  it("aborts oversized Content-Length responses upfront without reading chunks or calling JSON.parse", async () => {
    let chunkPulled = false;
    let parseCalled = false;
    const abortController = new AbortController();

    const body = new ReadableStream({
      pull(controller) {
        chunkPulled = true;
        controller.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0"}'));
        controller.close();
      },
    });

    const response = new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": "4096",
      },
    });

    await assert.rejects(
      () =>
        readBoundedRpcJson(response, {
          maxResponseBytes: 1024,
          abortController,
          parseJson: (txt) => {
            parseCalled = true;
            return JSON.parse(txt);
          },
        }),
      (err) => {
        assert.ok(err instanceof RpcResponseByteLimitError);
        assert.ok(err instanceof RpcResponseShapeError);
        assert.equal(err.problem, "response-bytes-oversized");
        assert.equal(err.limitSource, "content-length");
        assert.equal(err.maxResponseBytes, 1024);
        assert.equal(err.observedBytes, 4096);
        return true;
      },
    );

    assert.equal(abortController.signal.aborted, true);
    assert.equal(chunkPulled, false);
    assert.equal(parseCalled, false);
  });

  it("aborts chunked streams mid-flight before pulling remaining chunks or running JSON.parse", async () => {
    let chunksEmitted = 0;
    let streamCancelled = false;
    let parseCalled = false;
    const abortController = new AbortController();
    const chunkPayload = new Uint8Array(600).fill(0x61); // 'a'

    const body = new ReadableStream({
      pull(controller) {
        chunksEmitted += 1;
        if (chunksEmitted > 5) {
          throw new Error("should have aborted before pulling chunk 6");
        }
        controller.enqueue(chunkPayload);
      },
      cancel() {
        streamCancelled = true;
      },
    });

    const response = new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    await assert.rejects(
      () =>
        readBoundedRpcJson(response, {
          maxResponseBytes: 1024,
          abortController,
          parseJson: (txt) => {
            parseCalled = true;
            return JSON.parse(txt);
          },
        }),
      (err) => {
        assert.ok(err instanceof RpcResponseByteLimitError);
        assert.equal(err.limitSource, "stream");
        assert.equal(err.maxResponseBytes, 1024);
        assert.equal(err.observedBytes, 1200);
        // Never echoes payload content
        assert.equal(err.message.includes("aaaa"), false);
        return true;
      },
    );

    assert.equal(abortController.signal.aborted, true);
    assert.equal(streamCancelled, true);
    assert.equal(chunksEmitted, 2);
    assert.equal(parseCalled, false);
  });
});

describe("createRpcServer + poller cursor preservation (#804)", () => {
  it("accepts bounded RPC pages and aborts an oversized getEvents page while leaving target cursor unchanged", async () => {
    const tempDir = await createTempDataDir("mimir-byte-limit-");
    try {
      const initialMarketCursor = makeCursor(120);
      const initialSquadCursor = makeCursor(125);
      const cursorFile = tempDir.file("cursor.json");

      await writeFile(
        cursorFile,
        JSON.stringify({
          version: 1,
          updatedAt: "2026-10-01T00:00:00.000Z",
          targets: {
            market: { cursor: initialMarketCursor, lastEventLedger: 120 },
            squad: { cursor: initialSquadCursor, lastEventLedger: 125 },
          },
        }),
        "utf8",
      );

      const parsedPayloads = [];
      const rpcConfig = {
        rpcUrl: "https://soroban-testnet.stellar.org",
        horizonUrl: "https://horizon-testnet.stellar.org",
        networkPassphrase: "Test SDF Network ; September 2015",
        explorerBaseUrl: "https://stellar.expert/explorer",
        marketContractId: MARKET_ID,
        squadContractId: SQUAD_ID,
        marketContractVersion: "v1",
        squadContractVersion: "v1",
        rpcMaxResponseBytes: 1024,
      };

      const fakeFetch = async (_url, init) => {
        const reqBody = JSON.parse(String(init?.body ?? "{}"));
        if (reqBody.method === "getHealth") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: reqBody.id,
              result: {
                status: "healthy",
                oldestLedger: 100,
                latestLedger: 200,
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }

        const contractId = reqBody.params?.filters?.[0]?.contractIds?.[0];
        if (contractId === MARKET_ID) {
          // Oversized streamed page (> 1024 bytes) for market contract
          const hugePadding = "x".repeat(2500);
          const payload = JSON.stringify({
            jsonrpc: "2.0",
            id: reqBody.id,
            result: {
              events: [],
              cursor: makeCursor(200),
              latestLedger: 200,
              padding: hugePadding,
            },
          });
          const encoded = new TextEncoder().encode(payload);
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(encoded.subarray(0, 700));
              controller.enqueue(encoded.subarray(700, 1400));
              controller.enqueue(encoded.subarray(1400));
              controller.close();
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        // Squad contract returns a compact, valid page that advances to 200
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: reqBody.id,
            result: {
              events: [],
              cursor: makeCursor(200),
              latestLedger: 200,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      };

      const server = createRpcServer(rpcConfig, {
        fetchImpl: fakeFetch,
        parseJson: (text) => {
          parsedPayloads.push(text.length);
          return JSON.parse(text);
        },
      });

      // Verify paginatedGetEvents rejects the oversized market page directly
      await assert.rejects(
        () =>
          paginatedGetEvents(
            server,
            [{ type: "contract", contractIds: [MARKET_ID] }],
            { cursor: initialMarketCursor },
          ),
        (err) => err instanceof RpcResponseByteLimitError,
      );

      // Verify none of the parsed JSON texts exceeded 1024 bytes!
      assert.ok(parsedPayloads.every((len) => len <= 1024));

      // Verify poller leaves market cursor unchanged while squad advances normally
      const poller = createPoller({
        config: {
          ...rpcConfig,
          locale: "en",
          version: "0.1.0",
          botToken: "fake-token",
          chatId: "-1001234567890",
          chatIds: ["-1001234567890"],
          allowedChatIds: [],
          operatorTelegramUserId: null,
          pollIntervalMs: 100_000,
          startLookbackLedgers: 60,
          cursorFile,
          countersFile: tempDir.file("counters.json"),
          lockFile: tempDir.file("poller.lock"),
          statusFile: tempDir.file("status.json"),
          auditFile: tempDir.file("audit.jsonl"),
          deadLetterFile: tempDir.file("dead-letter.json"),
          sendJournalFile: tempDir.file("send-journal.jsonl"),
          csvOutputFile: tempDir.file("scan.csv"),
          maxNotificationsPerCycle: 5,
          interSendDelayMs: 0,
          metricsPort: null,
          notificationCategories: [],
          silentEvents: [],
          featureFlags: { enabled: true, market: true, squad: true },
          dedupWindow: 64,
          deadLetterMax: 10,
          deadLetterMaxAttempts: 3,
          healthHost: "127.0.0.1",
          healthPort: 0,
          healthStaleMs: 90_000,
          startupHealthDeadlineMs: 0,
          startupHealthRetryMs: 0,
          shutdownTimeoutMs: 2_000,
          telegramSendTimeoutMs: 2_000,
          channelPreviewMode: false,
          linkPreviewMarket: false,
          linkPreviewSquad: false,
          logSampleMaxPerWindow: 3,
          logSampleWindowMs: 60_000,
          logBufferLines: 50,
          telegramWebhookUrl: null,
          telegramApiRoot: null,
          mimirAppUrl: null,
          healthAuthToken: null,
        },
        server,
        send: async () => undefined,
      });

      try {
        await poller.start();
        const deadline = Date.now() + 2_000;
        while (poller.status().cycles < 1 || poller.status().lastSuccessAt === null) {
          if (Date.now() > deadline) throw new Error("poller cycle timed out");
          await new Promise((r) => setTimeout(r, 10));
        }

        const status = poller.status();
        const marketState = status.targets.find((t) => t.source === "market");
        const squadState = status.targets.find((t) => t.source === "squad");

        // Market failed due to oversized response -> cursor MUST remain unchanged!
        assert.equal(marketState.cursor, initialMarketCursor);
        assert.match(marketState.lastError ?? "", /exceeds configured limit of 1024 bytes/);

        // Squad succeeded -> cursor advanced cleanly to tip!
        assert.equal(squadState.cursor, makeCursor(200));

        await poller.shutdown();

        const saved = JSON.parse(await readFile(cursorFile, "utf8"));
        assert.equal(saved.targets.market.cursor, initialMarketCursor);
        assert.equal(saved.targets.squad.cursor, makeCursor(200));
      } finally {
        poller.stop();
      }
    } finally {
      await tempDir.cleanup();
    }
  });
});

describe("STELLAR_RPC_MAX_RESPONSE_BYTES configuration (#804)", () => {
  it("loads default limit and validates STELLAR_RPC_MAX_RESPONSE_BYTES >= 1024", () => {
    const prev = {
      MARKET_CONTRACT_ID: process.env.MARKET_CONTRACT_ID,
      SQUAD_CONTRACT_ID: process.env.SQUAD_CONTRACT_ID,
      STELLAR_RPC_MAX_RESPONSE_BYTES: process.env.STELLAR_RPC_MAX_RESPONSE_BYTES,
    };

    try {
      process.env.MARKET_CONTRACT_ID = MARKET_ID;
      process.env.SQUAD_CONTRACT_ID = SQUAD_ID;
      delete process.env.STELLAR_RPC_MAX_RESPONSE_BYTES;

      const def = loadStellarConfig();
      assert.equal(def.rpcMaxResponseBytes, DEFAULT_RPC_MAX_RESPONSE_BYTES);

      process.env.STELLAR_RPC_MAX_RESPONSE_BYTES = "2048";
      const custom = loadStellarConfig();
      assert.equal(custom.rpcMaxResponseBytes, 2048);

      process.env.STELLAR_RPC_MAX_RESPONSE_BYTES = "512";
      assert.throws(
        () => loadStellarConfig(),
        (err) => err instanceof ConfigError && err.message.includes("STELLAR_RPC_MAX_RESPONSE_BYTES"),
      );
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
