import assert from "node:assert/strict";
import test from "node:test";

import { registerCommandHandlers } from "../dist/bot.js";
import {
  MAX_EXPORT_BYTES,
  MAX_EXPORT_CHARS,
  TELEGRAM_CAPTION_MAX_CHARS,
  TELEGRAM_DOCUMENT_MAX_BYTES,
  TELEGRAM_MESSAGE_MAX_CHARS,
  createLogCapture,
  formatLogExportCaption,
  renderLogExport,
  renderLogExportWithMeta,
} from "../dist/logger.js";

const SYNTHETIC_BOT_TOK = ["0000000000", "SYNTHETIC-EXPORT-TEST-CRED"].join(":");

function baseConfig(overrides = {}) {
  return {
    version: "0.1.0",
    marketContractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    squadContractId: "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY",
    rpcUrl: "https://example.invalid/rpc",
    horizonUrl: "https://example.invalid/horizon",
    networkPassphrase: "Test SDF Network ; September 2015",
    botToken: SYNTHETIC_BOT_TOK,
    chatId: "-1001234567890",
    operatorTelegramUserId: "42",
    pollIntervalMs: 30_000,
    startLookbackLedgers: 60,
    cursorFile: "/tmp/unused-cursor.json",
    maxNotificationsPerCycle: 20,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
    logBufferLines: 500,
    ...overrides,
  };
}

function baseStatus(overrides = {}) {
  return {
    running: true,
    paused: false,
    startedAt: 1_000,
    cycles: 4,
    lastPollAt: Date.UTC(2026, 10, 15, 11, 59, 50),
    lastSuccessAt: Date.UTC(2026, 10, 15, 11, 59, 50),
    latestLedger: 42,
    oldestLedger: 1,
    notificationsSent: 2,
    notificationsFailed: 0,
    eventsSkipped: 1,
    consecutiveFailures: 0,
    lastError: null,
    targets: [],
    ...overrides,
  };
}

function hasLoneSurrogates(value) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return true;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

test("untruncated export reports zero omissions and preserves clean output", () => {
  const t0 = Date.UTC(2026, 10, 15, 11, 58, 0);
  const timestamps = [t0, t0 + 15_000, t0 + 45_000];
  let idx = 0;
  const capture = createLogCapture(10, { now: () => timestamps[idx++] ?? t0 });

  capture.add("info", "[boot] starting poller");
  capture.add("log", "[poller] cycle 1 ok");
  capture.add("warn", "[poller] slow response");

  const now = t0 + 60_000;
  const { text, meta } = renderLogExportWithMeta(baseConfig(), baseStatus(), capture, { now });

  assert.equal(meta.truncated, false);
  assert.equal(meta.ringTruncated, false);
  assert.equal(meta.sizeTruncated, false);
  assert.equal(meta.totalCaptured, 3);
  assert.equal(meta.retainedCount, 3);
  assert.equal(meta.omittedCount, 0);
  assert.equal(meta.ringOmittedCount, 0);
  assert.equal(meta.exportOmittedCount, 0);
  assert.equal(meta.omittedBytes, 0);
  assert.deepEqual(meta.retainedBounds, { startAt: t0, endAt: t0 + 45_000 });
  assert.equal(meta.omittedBounds, null);
  assert.equal(text.includes("[truncation:"), false);
  assert.equal(text.includes("…[older log lines omitted]…"), false);
});

test("ring-buffer overflow reports exact retained vs omitted counts and time bounds", () => {
  const baseTs = Date.UTC(2026, 10, 15, 11, 50, 0);
  let step = 0;
  const capture = createLogCapture(3, {
    now: () => {
      const ts = baseTs + step * 10_000;
      step += 1;
      return ts;
    },
  });

  for (let i = 0; i < 5; i += 1) {
    capture.add("info", `event-${i}`);
  }

  const stats = capture.stats();
  assert.equal(stats.totalCaptured, 5);
  assert.equal(stats.retainedCount, 3);
  assert.equal(stats.omittedCount, 2);
  assert.deepEqual(stats.omittedBounds, { startAt: baseTs, endAt: baseTs + 10_000 });
  assert.deepEqual(stats.retainedBounds, { startAt: baseTs + 20_000, endAt: baseTs + 40_000 });

  const now = baseTs + 60_000;
  const { text, meta } = renderLogExportWithMeta(baseConfig(), baseStatus(), capture, { now });

  assert.equal(meta.truncated, true);
  assert.equal(meta.ringTruncated, true);
  assert.equal(meta.sizeTruncated, false);
  assert.equal(meta.retainedCount, 3);
  assert.equal(meta.omittedCount, 2);
  assert.equal(meta.ringOmittedCount, 2);
  assert.equal(meta.exportOmittedCount, 0);
  assert.deepEqual(meta.omittedBounds, { startAt: baseTs, endAt: baseTs + 10_000 });
  assert.deepEqual(meta.retainedBounds, { startAt: baseTs + 20_000, endAt: baseTs + 40_000 });

  assert.match(text, /\[truncation: retained 3 of 5 lines, omitted 2 \(ring: 2, export: 0\)/);
  assert.ok(
    text.includes(
      `retained bounds ${new Date(baseTs + 20_000).toISOString()}..${new Date(baseTs + 40_000).toISOString()} (40s..20s ago)`,
    ),
  );
  assert.ok(
    text.includes(
      `omitted bounds ${new Date(baseTs).toISOString()}..${new Date(baseTs + 10_000).toISOString()} (1m..50s ago)`,
    ),
  );
  assert.equal(renderLogExport(baseConfig(), baseStatus(), capture, now), text);
});

test("size-capped export reports middle-omitted line counts, byte count, and time bounds", () => {
  const baseTs = Date.UTC(2026, 10, 15, 11, 0, 0);
  let step = 0;
  const capture = createLogCapture(50, {
    now: () => {
      const ts = baseTs + step * 1_000;
      step += 1;
      return ts;
    },
  });

  for (let i = 0; i < 45; i += 1) {
    capture.add("info", `entry-${i} ${"x".repeat(950)}`);
  }

  const now = baseTs + 60_000;
  const { text, meta } = renderLogExportWithMeta(baseConfig(), baseStatus(), capture, { now });

  assert.equal(meta.truncated, true);
  assert.equal(meta.ringTruncated, false);
  assert.equal(meta.sizeTruncated, true);
  assert.equal(meta.totalCaptured, 45);
  assert.equal(meta.ringOmittedCount, 0);
  assert.ok(meta.exportOmittedCount > 0, "middle lines must be counted as omitted");
  assert.equal(meta.retainedCount + meta.omittedCount, 45);
  assert.ok(meta.omittedBytes > 0);
  assert.ok(text.length <= MAX_EXPORT_CHARS);
  assert.ok(Buffer.byteLength(text, "utf8") <= MAX_EXPORT_BYTES);
  assert.ok(Buffer.byteLength(text, "utf8") <= TELEGRAM_DOCUMENT_MAX_BYTES);
  assert.ok(meta.retainedBounds !== null);
  assert.ok(meta.omittedBounds !== null);
  assert.equal(meta.retainedBounds.startAt, baseTs);
  assert.equal(meta.retainedBounds.endAt, baseTs + 44_000);
  assert.ok(meta.omittedBounds.startAt > baseTs);
  assert.ok(meta.omittedBounds.endAt < baseTs + 44_000);
  assert.ok(text.includes("…[older log lines omitted]…"));
  assert.ok(
    text.includes(
      `[truncation: retained ${meta.retainedCount} of 45 lines, omitted ${meta.omittedCount} (ring: 0, export: ${meta.exportOmittedCount}, middle-trimmed: ${meta.omittedBytes}B)`,
    ),
  );
});

test("combined ring eviction and size-cap trimming merges counts and time bounds coherently", () => {
  const baseTs = Date.UTC(2026, 10, 15, 10, 0, 0);
  let step = 0;
  const capture = createLogCapture(35, {
    now: () => {
      const ts = baseTs + step * 1_000;
      step += 1;
      return ts;
    },
  });

  for (let i = 0; i < 80; i += 1) {
    capture.add("warn", `combined-${i} cred=${SYNTHETIC_BOT_TOK} ${"y".repeat(1_100)}`);
  }

  const now = baseTs + 120_000;
  const { text, meta } = renderLogExportWithMeta(baseConfig(), baseStatus(), capture, { now });

  assert.equal(meta.truncated, true);
  assert.equal(meta.ringTruncated, true);
  assert.equal(meta.sizeTruncated, true);
  assert.equal(meta.totalCaptured, 80);
  assert.equal(meta.ringOmittedCount, 45);
  assert.ok(meta.exportOmittedCount > 0);
  assert.equal(meta.omittedCount, meta.ringOmittedCount + meta.exportOmittedCount);
  assert.equal(meta.retainedCount + meta.omittedCount, 80);
  assert.equal(meta.omittedBounds.startAt, baseTs);
  assert.ok(meta.omittedBounds.endAt > baseTs + 44_000);
  assert.equal(meta.retainedBounds.endAt, baseTs + 79_000);
  assert.equal(text.includes(SYNTHETIC_BOT_TOK), false);
  assert.ok(text.length <= MAX_EXPORT_CHARS);
  assert.ok(Buffer.byteLength(text, "utf8") <= MAX_EXPORT_BYTES);
});

test("multi-byte UTF-8 and emoji payloads stay within byte limits without splitting surrogate pairs", () => {
  const baseTs = Date.UTC(2026, 10, 15, 12, 0, 0);
  let step = 0;
  const capture = createLogCapture(30, {
    now: () => baseTs + step++ * 1_000,
  });

  // 25 lines × 900 3-byte BMP chars ("●") = 22,500 chars (< 32,000 MAX_EXPORT_CHARS)
  // but > 67,500 UTF-8 bytes (> 65,536 MAX_EXPORT_BYTES), plus 4-byte emoji pairs ("🚀").
  for (let i = 0; i < 25; i += 1) {
    capture.add("info", `utf8-${i} ${"🚀".repeat(50)}${"●".repeat(900)}`);
  }

  const { text, meta } = renderLogExportWithMeta(baseConfig(), baseStatus(), capture, {
    now: baseTs + 30_000,
  });

  assert.equal(meta.sizeTruncated, true);
  assert.ok(meta.byteLength <= MAX_EXPORT_BYTES, `byteLength ${meta.byteLength} <= ${MAX_EXPORT_BYTES}`);
  assert.ok(meta.byteLength <= TELEGRAM_DOCUMENT_MAX_BYTES);
  assert.equal(Buffer.byteLength(text, "utf8"), meta.byteLength);
  assert.equal(hasLoneSurrogates(text), false, "must never split UTF-16 surrogate pairs");
  assert.equal(Buffer.from(text, "utf8").toString("utf8"), text);

  // Explicit tight maxBytes budget and ceiling clamp above TELEGRAM_DOCUMENT_MAX_BYTES.
  const tight = renderLogExportWithMeta(baseConfig(), baseStatus(), capture, {
    now: baseTs + 30_000,
    maxBytes: 2_048,
  });
  assert.ok(Buffer.byteLength(tight.text, "utf8") <= 2_048);
  assert.equal(hasLoneSurrogates(tight.text), false);

  const clamped = renderLogExportWithMeta(baseConfig(), baseStatus(), capture, {
    now: baseTs + 30_000,
    maxBytes: TELEGRAM_DOCUMENT_MAX_BYTES * 4,
  });
  assert.equal(clamped.meta.maxBytes, TELEGRAM_DOCUMENT_MAX_BYTES);
  assert.ok(clamped.meta.byteLength <= TELEGRAM_DOCUMENT_MAX_BYTES);
});

test("/export sends short exports inline and uploads >4096-char exports as bounded Telegram documents", async () => {
  const handlers = new Map();
  const makeBot = (logs) => {
    handlers.clear();
    registerCommandHandlers(
      {
        command: (name, handler) => handlers.set(name, handler),
        callbackQuery: () => undefined,
      },
      {
        config: baseConfig(),
        status: () => baseStatus(),
        pause: () => "paused",
        resume: () => "resumed",
        logs,
      },
    );
    return handlers.get("export");
  };

  // 1. Short export (<= 4,096 chars) uses inline ctx.reply even when replyWithDocument exists.
  const smallLogs = createLogCapture(10);
  smallLogs.add("info", "short line");
  const smallHandler = makeBot(smallLogs);
  const inlineReplies = [];
  const docReplies = [];
  await smallHandler({
    from: { id: 42 },
    chat: { id: -1001234567890 },
    update: { update_id: 1 },
    reply: async (...args) => inlineReplies.push(args),
    replyWithDocument: async (...args) => docReplies.push(args),
  });
  assert.equal(inlineReplies.length, 1);
  assert.equal(docReplies.length, 0);
  assert.ok(inlineReplies[0][0].length <= TELEGRAM_MESSAGE_MAX_CHARS);

  // 2. Large export (> 4,096 chars) with ring eviction uploads as document within Telegram limits.
  const largeLogs = createLogCapture(12);
  for (let i = 0; i < 18; i += 1) {
    largeLogs.add("warn", `line-${i} cred=${SYNTHETIC_BOT_TOK} ${"z".repeat(600)}`);
  }
  const largeHandler = makeBot(largeLogs);
  const largeInline = [];
  const largeDocs = [];
  await largeHandler({
    from: { id: 42 },
    chat: { id: -1001234567890 },
    update: { update_id: 2 },
    reply: async (...args) => largeInline.push(args),
    replyWithDocument: async (...args) => largeDocs.push(args),
  });
  assert.equal(largeInline.length, 0);
  assert.equal(largeDocs.length, 1);
  const [inputFile, options] = largeDocs[0];
  assert.equal(inputFile.filename, "mimir-log-export.txt");
  const rawBytes = Buffer.from(await inputFile.toRaw());
  assert.ok(rawBytes.byteLength > TELEGRAM_MESSAGE_MAX_CHARS);
  assert.ok(rawBytes.byteLength <= MAX_EXPORT_BYTES);
  assert.ok(rawBytes.byteLength <= TELEGRAM_DOCUMENT_MAX_BYTES);
  const uploadedText = rawBytes.toString("utf8");
  assert.equal(uploadedText.includes(SYNTHETIC_BOT_TOK), false);
  assert.match(uploadedText, /\[truncation: retained 12 of 18 lines, omitted 6/);
  assert.ok(options.caption.length <= TELEGRAM_CAPTION_MAX_CHARS);
  assert.match(options.caption, /retained 12 of 18 lines, omitted 6/);

  // 3. Caption helper hard-bounds even oversized synthetic versions.
  const { meta } = renderLogExportWithMeta(baseConfig(), baseStatus(), largeLogs);
  const longCaption = formatLogExportCaption(
    baseConfig({ version: "v".repeat(2_000) }),
    meta,
  );
  assert.equal(longCaption.length, TELEGRAM_CAPTION_MAX_CHARS);
});
