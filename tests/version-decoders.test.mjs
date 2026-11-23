import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeEvent,
  DEFAULT_CONTRACT_VERSION,
  MARKET_DECODERS,
  normalizeContractVersion,
  SQUAD_DECODERS,
  ADMIN_EVENT_NAMES,
  isContractVersionSupported,
  listSupportedEventSchemas,
  getDecoderCapabilityReport,
  getGenericDecoderCapabilityReport,
  getConfiguredDecoderCapabilities,
  validateDecoderCombinations,
  formatDecoderCapabilityReport,
} from "../dist/stellar/decode.js";
import { createPoller } from "../dist/poller.js";
import { Logger } from "../dist/logger.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadStellarConfig } from "../dist/config.js";
import { contractsMessage, statusMessage } from "../dist/bot.js";
import { buildHealthReport } from "../dist/health.js";
import { Address, xdr } from "@stellar/stellar-sdk";

test("normalizeContractVersion handles defaults, trimming, and casing", () => {
  assert.equal(normalizeContractVersion(""), DEFAULT_CONTRACT_VERSION);
  assert.equal(normalizeContractVersion(undefined), DEFAULT_CONTRACT_VERSION);
  assert.equal(normalizeContractVersion(" V2 "), "v2");
  assert.equal(normalizeContractVersion("v1"), "v1");
});

test("MARKET_DECODERS and SQUAD_DECODERS registries contain v1 and v2 decoders", () => {
  assert.ok(typeof MARKET_DECODERS.v1 === "function");
  assert.ok(typeof MARKET_DECODERS.v2 === "function");
  assert.ok(typeof SQUAD_DECODERS.v1 === "function");
  assert.ok(typeof SQUAD_DECODERS.v2 === "function");
});

test("decodeEvent positive: market v1 event claim_created", () => {
  const creatorAddr = xdr.ScVal.scvString("GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW");
  const event = {
    contractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    ledger: 100,
    txHash: "tx123",
    ledgerClosedAt: "2026-09-25T00:00:00Z",
    id: "100-1",
    topic: [
      xdr.ScVal.scvSymbol("claim_created"),
      xdr.ScVal.scvU64(1n),
      creatorAddr,
    ],
    value: xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("category"),
        val: xdr.ScVal.scvString("crypto"),
      }),
    ]),
  };

  const decoded = decodeEvent("market", event, "v1");
  assert.equal(decoded.source, "market");
  assert.equal(decoded.version, "v1");
  assert.equal(decoded.payload.name, "claim_created");
  if (decoded.payload.name === "claim_created") {
    assert.equal(decoded.payload.claimId, 1);
    assert.equal(decoded.payload.category, "crypto");
  }
});

test("decodeEvent positive: market v2 event claim_created with title extension", () => {
  const creatorAddr = xdr.ScVal.scvString("GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW");
  const event = {
    contractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    ledger: 101,
    txHash: "tx124",
    ledgerClosedAt: "2026-09-25T00:00:00Z",
    id: "101-1",
    topic: [
      xdr.ScVal.scvSymbol("claim_created"),
      xdr.ScVal.scvU64(2n),
      creatorAddr,
    ],
    value: xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("category"),
        val: xdr.ScVal.scvString("crypto"),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("title"),
        val: xdr.ScVal.scvString("Stellar Protocol 22"),
      }),
    ]),
  };

  const decoded = decodeEvent("market", event, "v2");
  assert.equal(decoded.version, "v2");
  assert.equal(decoded.payload.name, "claim_created");
  if (decoded.payload.name === "claim_created") {
    assert.equal(decoded.payload.claimId, 2);
    assert.equal(decoded.payload.title, "Stellar Protocol 22");
  }
});

test("decodeEvent negative: unknown event name becomes unknown payload", () => {
  const event = {
    contractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    ledger: 102,
    txHash: "tx125",
    topic: [xdr.ScVal.scvSymbol("unknown_future_event")],
    value: xdr.ScVal.scvVoid(),
  };

  const decoded = decodeEvent("market", event, "v1");
  assert.equal(decoded.payload.name, "unknown");
  if (decoded.payload.name === "unknown") {
    assert.equal(decoded.payload.eventName, "unknown_future_event");
  }
});

test("decodeEvent boundary: malformed XDR value never crashes decoder", () => {
  const event = {
    contractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    ledger: 103,
    txHash: "tx126",
    topic: [xdr.ScVal.scvSymbol("claim_created")],
    value: {
      // Intentionally invalid ScVal object that will fail scValToNative
      switch: () => {
        throw new Error("Invalid XDR discriminator");
      },
    },
  };

  const decoded = decodeEvent("market", event, "v1");
  assert.equal(decoded.payload.name, "unknown");
  if (decoded.payload.name === "unknown") {
    assert.match(decoded.payload.reason, /malformed XDR value/);
  }
});

test("decodeEvent boundary: invalid strkey address in topic yields unknown payload", () => {
  const event = {
    contractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    ledger: 104,
    txHash: "tx127",
    topic: [
      xdr.ScVal.scvSymbol("claim_created"),
      xdr.ScVal.scvU64(1n),
      xdr.ScVal.scvString("NOT_A_VALID_STELLAR_ADDRESS"),
    ],
    value: xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("category"),
        val: xdr.ScVal.scvString("tech"),
      }),
    ]),
  };

  const decoded = decodeEvent("market", event, "v1");
  assert.equal(decoded.payload.name, "unknown");
  if (decoded.payload.name === "unknown") {
    assert.match(decoded.payload.reason, /expected a Stellar address strkey/);
  }
});

test("loadStellarConfig loads MARKET_CONTRACT_VERSION and SQUAD_CONTRACT_VERSION", () => {
  process.env.MARKET_CONTRACT_ID = "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";
  process.env.SQUAD_CONTRACT_ID = "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY";
  process.env.MARKET_CONTRACT_VERSION = "v2";
  process.env.SQUAD_CONTRACT_VERSION = "v1";

  const config = loadStellarConfig();
  assert.equal(config.marketContractVersion, "v2");
  assert.equal(config.squadContractVersion, "v1");
});

test("contractsMessage formats contract version in output", () => {
  const config = {
    marketContractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    squadContractId: "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY",
    marketContractVersion: "v2",
    squadContractVersion: "v1",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer",
  };

  const msg = contractsMessage(config);
  assert.match(msg, /mimir\\-market\* \\\(v2\\\)/);
  assert.match(msg, /mimir\\-squad\* \\\(v1\\\)/);
});

test("statusMessage and buildHealthReport display contract versions", () => {
  const config = {
    marketContractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    squadContractId: "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY",
    marketContractVersion: "v2",
    squadContractVersion: "v1",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer",
    pollIntervalMs: 30000,
    channelPreviewMode: false,
    healthPort: 0,
  };

  const pollerStatus = {
    running: true,
    paused: false,
    startedAt: 1000,
    cycles: 5,
    lastPollAt: 5000,
    lastSuccessAt: 5000,
    latestLedger: 120,
    oldestLedger: 1,
    notificationsSent: 2,
    notificationsFailed: 0,
    eventsSkipped: 0,
    consecutiveFailures: 0,
    lastError: null,
    targets: [
      {
        source: "market",
        contractId: config.marketContractId,
        version: "v2",
        cursor: "100-1",
        lastEventLedger: 110,
        lastError: null,
      },
      {
        source: "squad",
        contractId: config.squadContractId,
        version: "v1",
        cursor: "100-2",
        lastEventLedger: 115,
        lastError: null,
      },
    ],
  };

  const msg = statusMessage(config, pollerStatus);
  assert.match(msg, /mimir\\-market \\\(v2\\\)/);
  assert.match(msg, /mimir\\-squad \\\(v1\\\)/);

  const report = buildHealthReport(config, pollerStatus, 10000);
  assert.equal(report.poller.targets[0].version, "v2");
  assert.equal(report.poller.targets[1].version, "v1");
});

test("isContractVersionSupported checks supported versions for market, squad, and generic", () => {
  // market
  assert.equal(isContractVersionSupported("market", "v1"), true);
  assert.equal(isContractVersionSupported("market", "v2"), true);
  assert.equal(isContractVersionSupported("market", " V2 "), true);
  assert.equal(isContractVersionSupported("market", "v3"), false);
  assert.equal(isContractVersionSupported("market", "v99"), false);

  // squad
  assert.equal(isContractVersionSupported("squad", "v1"), true);
  assert.equal(isContractVersionSupported("squad", "v2"), true);
  assert.equal(isContractVersionSupported("squad", " V1 "), true);
  assert.equal(isContractVersionSupported("squad", "v3"), false);
  assert.equal(isContractVersionSupported("squad", "unknown"), false);

  // generic
  assert.equal(isContractVersionSupported("generic", "v1"), true);
  assert.equal(isContractVersionSupported("generic", "v99"), true);
  assert.equal(isContractVersionSupported("generic", "*"), true);
  assert.equal(isContractVersionSupported("generic", ""), true);

  // unknown source
  assert.equal(isContractVersionSupported("token", "v1"), false);
  assert.equal(isContractVersionSupported("custom", "v2"), false);
});

test("listSupportedEventSchemas returns schemas and extensions for market, squad, and generic", () => {
  // market v1
  const marketV1Schemas = listSupportedEventSchemas("market", "v1");
  assert.equal(marketV1Schemas.length, 18); // 9 non-admin + 9 admin
  const claimCreatedV1 = marketV1Schemas.find((s) => s.name === "claim_created");
  assert.ok(claimCreatedV1);
  assert.equal(claimCreatedV1.expectedTopicCount, 3);
  assert.deepEqual(claimCreatedV1.topicArgs, ["int", "address"]);
  assert.equal(claimCreatedV1.extensions, undefined);
  assert.equal(claimCreatedV1.isAdmin, false);

  const adminV1 = marketV1Schemas.find((s) => s.name === "oracle_changed");
  assert.ok(adminV1);
  assert.equal(adminV1.isAdmin, true);

  // market v2 has extensions
  const marketV2Schemas = listSupportedEventSchemas("market", "v2");
  const claimCreatedV2 = marketV2Schemas.find((s) => s.name === "claim_created");
  assert.ok(claimCreatedV2);
  assert.deepEqual(claimCreatedV2.extensions, ["title"]);

  const claimResolvedV2 = marketV2Schemas.find((s) => s.name === "claim_resolved");
  assert.ok(claimResolvedV2);
  assert.deepEqual(claimResolvedV2.extensions, ["resolver"]);

  // squad v1
  const squadV1Schemas = listSupportedEventSchemas("squad", "v1");
  assert.equal(squadV1Schemas.length, 15); // 6 non-admin + 9 admin
  const marketCreatedV1 = squadV1Schemas.find((s) => s.name === "market_created");
  assert.ok(marketCreatedV1);
  assert.equal(marketCreatedV1.extensions, undefined);

  // squad v2 has category extension
  const squadV2Schemas = listSupportedEventSchemas("squad", "v2");
  const marketCreatedV2 = squadV2Schemas.find((s) => s.name === "market_created");
  assert.ok(marketCreatedV2);
  assert.deepEqual(marketCreatedV2.extensions, ["category"]);

  // generic
  const genericSchemas = listSupportedEventSchemas("generic");
  assert.equal(genericSchemas.length, 1);
  assert.equal(genericSchemas[0].name, "*");

  // unknown source
  assert.deepEqual(listSupportedEventSchemas("unknown"), []);
});

test("getDecoderCapabilityReport generates comprehensive reports for supported and unsupported versions", () => {
  // market v1
  const repMarketV1 = getDecoderCapabilityReport("market", "v1", "CDV6...");
  assert.equal(repMarketV1.source, "market");
  assert.equal(repMarketV1.contractId, "CDV6...");
  assert.equal(repMarketV1.version, "v1");
  assert.equal(repMarketV1.normalizedVersion, "v1");
  assert.equal(repMarketV1.supported, true);
  assert.equal(repMarketV1.decoderKind, "typed");
  assert.equal(repMarketV1.fallbackVersion, undefined);
  assert.deepEqual(repMarketV1.supportedVersions, ["v1", "v2"]);
  assert.equal(repMarketV1.wildcardSupport, false);
  assert.ok(repMarketV1.events.includes("claim_created"));
  assert.ok(repMarketV1.adminEvents.includes("oracle_changed"));

  // market v2
  const repMarketV2 = getDecoderCapabilityReport("market", "v2");
  assert.equal(repMarketV2.supported, true);
  assert.equal(repMarketV2.normalizedVersion, "v2");

  // squad v2
  const repSquadV2 = getDecoderCapabilityReport("squad", "v2");
  assert.equal(repSquadV2.supported, true);
  assert.ok(repSquadV2.events.includes("market_created"));

  // unsupported market v3
  const repMarketV3 = getDecoderCapabilityReport("market", "v3");
  assert.equal(repMarketV3.supported, false);
  assert.equal(repMarketV3.version, "v3");
  assert.equal(repMarketV3.fallbackVersion, "v1");
  assert.deepEqual(repMarketV3.supportedVersions, ["v1", "v2"]);

  // unsupported unknown source
  const repUnknown = getDecoderCapabilityReport("oracle", "v1");
  assert.equal(repUnknown.supported, false);
  assert.equal(repUnknown.fallbackVersion, "v1");
  assert.deepEqual(repUnknown.supportedVersions, []);

  // generic
  const repGeneric = getDecoderCapabilityReport("generic");
  assert.equal(repGeneric.source, "generic");
  assert.equal(repGeneric.decoderKind, "generic");
  assert.equal(repGeneric.supported, true);
  assert.equal(repGeneric.wildcardSupport, true);
  assert.deepEqual(repGeneric.events, ["*"]);

  const repGenDirect = getGenericDecoderCapabilityReport("CGEN...");
  assert.equal(repGenDirect.source, "generic");
  assert.equal(repGenDirect.contractId, "CGEN...");
});

test("getConfiguredDecoderCapabilities returns reports for configured targets", () => {
  const reports = getConfiguredDecoderCapabilities({
    marketContractId: "CMARKET...",
    marketContractVersion: "v2",
    squadContractId: "CSQUAD...",
    squadContractVersion: "v1",
  });

  assert.equal(reports.length, 2);
  assert.equal(reports[0].source, "market");
  assert.equal(reports[0].version, "v2");
  assert.equal(reports[0].contractId, "CMARKET...");
  assert.equal(reports[0].supported, true);

  assert.equal(reports[1].source, "squad");
  assert.equal(reports[1].version, "v1");
  assert.equal(reports[1].contractId, "CSQUAD...");
  assert.equal(reports[1].supported, true);
});

test("validateDecoderCombinations flags unsupported combinations and unknown sources", () => {
  // supported
  const valid = validateDecoderCombinations([
    { source: "market", version: "v1", contractId: "C1" },
    { source: "squad", version: "v2", contractId: "C2" },
  ]);
  assert.deepEqual(valid, []);

  // unsupported version & unknown source
  const invalid = validateDecoderCombinations([
    { source: "market", version: "v3", contractId: "C1" },
    { source: "squad", version: "v1", contractId: "C2" },
    { source: "other", version: "v1", contractId: "C3" },
  ]);
  assert.equal(invalid.length, 2);

  assert.equal(invalid[0].source, "market");
  assert.equal(invalid[0].version, "v3");
  assert.equal(invalid[0].fallbackVersion, "v1");
  assert.match(invalid[0].reason, /not supported.*supported: v1, v2/);

  assert.equal(invalid[1].source, "other");
  assert.equal(invalid[1].fallbackVersion, "v1");
  assert.match(invalid[1].reason, /unknown source 'other'/);
});

test("formatDecoderCapabilityReport formats human-readable report", () => {
  const repSupported = getDecoderCapabilityReport("market", "v2", "CDV6...");
  const text1 = formatDecoderCapabilityReport(repSupported);
  assert.match(text1, /Decoder Capability Report: market \(CDV6\.\.\.\)/);
  assert.match(text1, /Decoder Kind: typed/);
  assert.match(text1, /Version: v2/);
  assert.match(text1, /Supported: yes/);
  assert.match(text1, /Supported Versions: v1, v2/);
  assert.match(text1, /Events \(9\): claim_created/);

  const repUnsupported = getDecoderCapabilityReport("market", "v99");
  const text2 = formatDecoderCapabilityReport(repUnsupported);
  assert.match(text2, /Supported: no \(fallback: v1\)/);

  const repGen = getGenericDecoderCapabilityReport();
  const text3 = formatDecoderCapabilityReport(repGen);
  assert.match(text3, /Decoder Kind: generic/);
  assert.match(text3, /Wildcard Support: yes/);
});

test("poller flags unsupported contract version combinations before live polling begins", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "mimir-poller-cap-"));
  const cursorFile = path.join(tmpDir, "cursor.json");
  const lockFile = path.join(tmpDir, "poller.lock");

  const warned = [];
  const origWarn = Logger.warn;
  Logger.warn = (component, message, meta) => {
    warned.push({ component, message, meta });
  };

  try {
    const config = {
      marketContractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
      squadContractId: "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY",
      marketContractVersion: "v3", // unsupported
      squadContractVersion: "v1",  // supported
      pollIntervalMs: 50,
      cursorFile,
      lockFile,
      botToken: "0000000000:SECRET-TOKEN-DO-NOT-LEAK",
      rpcUrl: "http://127.0.0.1:8420/soroban/rpc",
      networkPassphrase: "Test SDF Network ; September 2015",
    };

    const poller = createPoller({
      config,
      server: {
        getHealth: async () => ({ status: "healthy", latestLedger: 100, oldestLedger: 1 }),
        getEvents: async () => ({ events: [], latestLedger: 100 }),
      },
      send: async () => {},
    });

    // Check capabilities() getter
    const caps = poller.capabilities();
    assert.equal(caps.length, 2);
    assert.equal(caps[0].source, "market");
    assert.equal(caps[0].supported, false);
    assert.equal(caps[0].version, "v3");
    assert.equal(caps[1].source, "squad");
    assert.equal(caps[1].supported, true);

    // Check status() reflection
    const status = poller.status();
    assert.equal(status.targets[0].supportedVersion, false);
    assert.equal(status.targets[1].supportedVersion, true);
    assert.ok(Array.isArray(status.unsupportedVersions));
    assert.equal(status.unsupportedVersions.length, 1);
    assert.equal(status.unsupportedVersions[0].source, "market");
    assert.equal(status.unsupportedVersions[0].version, "v3");
    assert.equal(status.unsupportedVersions[0].fallback, "v1");

    // Call start() - must flag unsupported version in Logger.warn before polling starts
    await poller.start();
    poller.stop();

    const warningLog = warned.find(
      (w) => w.meta && w.meta.action === "unsupported_contract_version",
    );
    assert.ok(warningLog, "Expected unsupported_contract_version warning log before polling begins");
    assert.equal(warningLog.meta.source, "market");
    assert.equal(warningLog.meta.version, "v3");
    assert.equal(warningLog.meta.fallbackVersion, "v1");
  } finally {
    Logger.warn = origWarn;
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});
