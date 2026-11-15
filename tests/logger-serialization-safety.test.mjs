import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  attachConsole,
  CIRCULAR_SENTINEL,
  createLogCapture,
  DEPTH_LIMIT_SENTINEL,
  FUNCTION_SENTINEL,
  Logger,
  SYMBOL_SENTINEL,
  UNSERIALIZABLE_SENTINEL,
} from "../dist/logger.js";
import { createPoller } from "../dist/poller.js";
import { clearSecrets, redactError, redactText } from "../dist/redact.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

function captureLogger() {
  const entries = [];
  Logger.configure({
    sink: (level, line) => {
      entries.push({ level, line });
    },
  });
  return entries;
}

test.afterEach(() => {
  Logger.reset();
  clearSecrets();
});

test("replaces circular references and unsupported JS values with bounded sentinels while keeping sibling fields", () => {
  const entries = captureLogger();
  Logger.configure({
    format: "json",
    now: () => new Date("2026-11-01T00:00:00.000Z"),
  });

  const shared = { id: "shared-ref" };
  const ring = { label: "root", first: shared, second: shared };
  ring.back = ring;

  const cyclicArray = ["head"];
  cyclicArray.push(cyclicArray);

  Logger.warn("poller", "complex payload observed", {
    ring,
    cyclicArray,
    fn: () => "ignored",
    sym: Symbol("secret-tag"),
    arrMixed: [undefined, Symbol("s"), () => 1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY],
    invalidDate: new Date(Number.NaN),
    validDate: new Date("2026-11-01T01:02:03.000Z"),
    mapVal: new Map([["a", 1], ["b", 2]]),
    setVal: new Set([1, 2, 3]),
    bytes: new Uint8Array([1, 2, 3, 4]),
    err: new TypeError("unexpected XDR tag"),
  });

  assert.equal(entries.length, 1);
  assert.equal(entries[0].level, "warn");
  const record = JSON.parse(entries[0].line);
  assert.equal(record.level, "warn");
  assert.equal(record.component, "poller");
  assert.equal(record.msg, "complex payload observed");

  // Shared non-cyclic DAG nodes are preserved; true ancestor cycle uses [circular]
  assert.deepEqual(record.ring.first, { id: "shared-ref" });
  assert.deepEqual(record.ring.second, { id: "shared-ref" });
  assert.equal(record.ring.back, CIRCULAR_SENTINEL);
  assert.deepEqual(record.cyclicArray, ["head", CIRCULAR_SENTINEL]);

  // Unsupported primitives and containers use bounded sentinels
  assert.equal(record.fn, FUNCTION_SENTINEL);
  assert.equal(record.sym, SYMBOL_SENTINEL);
  assert.deepEqual(record.arrMixed, [
    "[undefined]",
    SYMBOL_SENTINEL,
    FUNCTION_SENTINEL,
    "[NaN]",
    "[Infinity]",
    "[-Infinity]",
  ]);
  assert.equal(record.invalidDate, "[Invalid Date]");
  assert.equal(record.validDate, "2026-11-01T01:02:03.000Z");
  assert.equal(record.mapVal, "[Map(2)]");
  assert.equal(record.setVal, "[Set(3)]");
  assert.equal(record.bytes, "[Uint8Array(4)]");
  assert.deepEqual(record.err, { name: "TypeError", message: "unexpected XDR tag" });
});

test("isolates throwing getters, throwing toJSON, hostile proxies, invalid clocks, and sink throws", () => {
  const entries = captureLogger();
  Logger.configure({
    format: "json",
    now: () => new Date(Number.NaN),
  });

  const poisonToJson = {
    healthy: "kept",
    toJSON() {
      throw new Error("toJSON trap");
    },
  };
  Object.defineProperty(poisonToJson, "explodingProp", {
    enumerable: true,
    get() {
      throw new Error("getter trap");
    },
  });

  const hostileProxy = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error("proxy ownKeys trap");
      },
    },
  );

  const deep = { a: { b: { c: { d: { e: "bottom" } } } } };

  assert.doesNotThrow(() => {
    Logger.error("poller", "[poller] market scan failed", {
      action: "scan_failed",
      poisonToJson,
      hostileProxy,
      deep,
    });
  });

  assert.equal(entries.length, 1);
  assert.equal(entries[0].level, "error");
  const parsed = JSON.parse(entries[0].line);
  assert.equal(parsed.ts, "1970-01-01T00:00:00.000Z");
  assert.equal(parsed.level, "error");
  assert.equal(parsed.component, "poller");
  assert.equal(parsed.msg, "[poller] market scan failed");
  assert.equal(parsed.action, "scan_failed");
  assert.equal(parsed.poisonToJson.healthy, "kept");
  assert.equal(parsed.poisonToJson.toJSON, FUNCTION_SENTINEL);
  assert.equal(parsed.poisonToJson.explodingProp, UNSERIALIZABLE_SENTINEL);
  assert.equal(parsed.hostileProxy, UNSERIALIZABLE_SENTINEL);
  assert.equal(parsed.deep.a.b.c.d, DEPTH_LIMIT_SENTINEL);

  // Hostile top-level fields proxy still retains level and message in valid JSON
  assert.doesNotThrow(() => {
    Logger.fatal("poller", "fatal cycle state", hostileProxy);
  });
  assert.equal(entries.length, 2);
  assert.equal(entries[1].level, "fatal");
  const proxyEnvelope = JSON.parse(entries[1].line);
  assert.equal(proxyEnvelope.level, "fatal");
  assert.equal(proxyEnvelope.msg, "fatal cycle state");
  assert.equal(proxyEnvelope.fields, UNSERIALIZABLE_SENTINEL);

  // Throwing sink and null-prototype message never propagate exceptions
  Logger.configure({
    format: "text",
    sink: () => {
      throw new Error("EPIPE broken stdout");
    },
  });
  const nullProtoMsg = Object.create(null);
  assert.doesNotThrow(() => {
    Logger.error("poller", nullProtoMsg);
  });
});

test("redactError and attachConsole survive null-prototype circular objects and throwing Error getters", () => {
  const nullProtoCyclic = Object.create(null);
  nullProtoCyclic.tag = "rpc";
  nullProtoCyclic.self = nullProtoCyclic;

  const redactedNullProto = redactError(nullProtoCyclic);
  assert.equal(redactedNullProto, `{"tag":"rpc","self":"${CIRCULAR_SENTINEL}"}`);

  const hostileError = new Error("initial");
  Object.defineProperty(hostileError, "message", {
    get() {
      throw new Error("message getter threw");
    },
  });
  assert.equal(redactError(hostileError), UNSERIALIZABLE_SENTINEL);
  assert.equal(redactText(nullProtoCyclic), `{"tag":"rpc","self":"${CIRCULAR_SENTINEL}"}`);

  const capture = createLogCapture(10);
  const originalError = console.error;
  console.error = () => undefined;
  const restore = attachConsole(capture, []);
  try {
    assert.doesNotThrow(() => {
      console.error("[poller] upstream threw", Object.create(null));
    });
  } finally {
    restore();
    console.error = originalError;
  }

  assert.equal(capture.size(), 1);
  assert.equal(capture.lines()[0].level, "error");
  assert.equal(capture.lines()[0].text, `[poller] upstream threw ${UNSERIALIZABLE_SENTINEL}`);
});

test("poller continues subsequent cycles when RPC throws hostile circular/null-prototype errors under JSON logging", async () => {
  await withTempDataDir(async (tmp) => {
    const logged = captureLogger();
    Logger.configure({ format: "json", level: "debug" });

    let healthCalls = 0;
    const server = {
      getHealth: async () => {
        healthCalls += 1;
        if (healthCalls === 1) {
          const cyclicNullProto = Object.create(null);
          cyclicNullProto.self = cyclicNullProto;
          throw cyclicNullProto;
        }
        if (healthCalls === 2) {
          const badErr = new Error("ignored");
          Object.defineProperty(badErr, "message", {
            get() {
              throw new Error("hostile error message getter");
            },
          });
          throw badErr;
        }
        return { status: "healthy", latestLedger: 120, oldestLedger: 60 };
      },
      getEvents: async () => ({ events: [], latestLedger: 120 }),
    };

    const config = {
      marketContractId: "C" + "A".repeat(55),
      squadContractId: "C" + "B".repeat(55),
      rpcUrl: "https://example.invalid/rpc",
      horizonUrl: "https://example.invalid/horizon",
      networkPassphrase: "Test SDF Network ; September 2015",
      explorerBaseUrl: "https://example.invalid/explorer",
      botToken: ["123456789:", "TEST_ONLY_SERIALIZATION_SAFETY_TOKEN"].join(""),
      chatId: "-1001234567890",
      operatorTelegramUserId: "42",
      pollIntervalMs: 1_000,
      startLookbackLedgers: 10,
      cursorFile: path.join(tmp.root, "cursor.json"),
      maxNotificationsPerCycle: 20,
      healthHost: "127.0.0.1",
      healthPort: 0,
      healthStaleMs: 90_000,
    };

    const poller = createPoller({
      config,
      server,
      send: async () => undefined,
      targetBackoffOptions: { initialBackoffMs: 0 },
      circuitBreakerOptions: { failureThreshold: 100 },
      sleep: async () => undefined,
    });

    await assert.doesNotReject(async () => {
      await poller.runCycle();
      await poller.runCycle();
    });

    const status = poller.status();
    assert.equal(status.cycles, 2);
    assert.ok(logged.length >= 2);
    for (const entry of logged) {
      const parsed = JSON.parse(entry.line);
      assert.equal(parsed.level, entry.level);
      assert.equal(typeof parsed.msg, "string");
      assert.ok(parsed.msg.length > 0);
    }
  });
});
