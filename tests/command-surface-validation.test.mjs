import assert from "node:assert/strict";
import test from "node:test";

import {
  COMMAND_DETAILS,
  COMMANDS,
  CommandSurfaceValidationError,
  createBot,
  extractHelpOverviewCommands,
  helpMessage,
  registerCommandHandlers,
  registerCommands,
  validateCommandSurface,
} from "../dist/bot.js";
import { COMMAND_NAMES } from "../dist/i18n.js";
import { registeredCommands } from "../dist/commands/index.js";

function makeConfig(overrides = {}) {
  return {
    botToken: ["123456:", "A".repeat(35)].join(""),
    chatId: "-1001234567890",
    allowedChatIds: [],
    operatorTelegramUserId: "42",
    pollIntervalMs: 30_000,
    startLookbackLedgers: 60,
    cursorFile: "/tmp/unused-cursor.json",
    maxNotificationsPerCycle: 20,
    marketContractId: "C" + "A".repeat(55),
    squadContractId: "C" + "B".repeat(55),
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    ...overrides,
  };
}

function makeDeps(configOverrides = {}) {
  return {
    config: makeConfig(configOverrides),
    status: () => ({
      running: true,
      paused: false,
      startedAt: 1,
      cycles: 0,
      lastPollAt: null,
      lastSuccessAt: null,
      latestLedger: null,
      oldestLedger: null,
      notificationsSent: 0,
      notificationsFailed: 0,
      eventsSkipped: 0,
      consecutiveFailures: 0,
      lastError: null,
      targets: [],
    }),
    pause: () => "paused",
    resume: () => "resumed",
  };
}

test("validateCommandSurface succeeds on the live catalogue, help, menu, and registered handlers", async () => {
  assert.doesNotThrow(() => validateCommandSurface({ config: makeConfig() }));
  assert.doesNotThrow(() =>
    validateCommandSurface({ config: makeConfig({ operatorTelegramUserId: null }) }),
  );

  const extractedAll = extractHelpOverviewCommands(helpMessage(makeConfig()));
  assert.deepEqual(extractedAll, [...COMMAND_NAMES]);

  const bot = createBot(makeDeps());
  assert.ok(bot);

  const fakeApiBot = {
    api: {
      setMyCommands: async () => true,
    },
  };
  await assert.doesNotReject(() => registerCommands(fakeApiBot, makeConfig()));
});

test("validateCommandSurface stops startup and names a catalogue command without a live handler", () => {
  assert.throws(
    () =>
      validateCommandSurface({
        catalogueCommands: [...COMMAND_NAMES, "ghost_catalogue"],
      }),
    (err) => {
      assert.ok(err instanceof CommandSurfaceValidationError);
      assert.ok(err.missingCommands.includes("ghost_catalogue"));
      assert.match(err.message, /\/ghost_catalogue/);
      assert.match(err.message, /Catalogue advertises \/ghost_catalogue without a live registered handler/);
      return true;
    },
  );
});

test("validateCommandSurface detects COMMAND_DETAILS and /help overview commands without live handlers", () => {
  assert.throws(
    () =>
      validateCommandSurface({
        helpDetails: {
          ...COMMAND_DETAILS,
          ghost_detail: {
            usage: "/ghost_detail",
            arguments: "None",
            whoCanRun: "Anyone",
            operatorOnly: false,
            description: "Advertised in detail table without a handler",
            examples: ["/ghost_detail"],
          },
        },
      }),
    (err) => {
      assert.ok(err instanceof CommandSurfaceValidationError);
      assert.ok(err.missingCommands.includes("ghost_detail"));
      assert.match(err.message, /\/ghost_detail/);
      return true;
    },
  );

  assert.throws(
    () =>
      validateCommandSurface({
        helpOverviewText: `${helpMessage(makeConfig())}\n/ghost_overview — Missing handler`,
      }),
    (err) => {
      assert.ok(err instanceof CommandSurfaceValidationError);
      assert.ok(err.missingCommands.includes("ghost_overview"));
      assert.match(err.message, /\/ghost_overview/);
      return true;
    },
  );
});

test("validateCommandSurface detects menu items and localized descriptions without live handlers", () => {
  assert.throws(
    () =>
      validateCommandSurface({
        menuMetadata: [
          ...COMMANDS,
          { command: "ghost_menu", description: "Ghost menu item", operatorOnly: false },
        ],
      }),
    (err) => {
      assert.ok(err instanceof CommandSurfaceValidationError);
      assert.ok(err.missingCommands.includes("ghost_menu"));
      assert.match(err.message, /Command menu advertises \/ghost_menu without a live registered handler/);
      return true;
    },
  );

  assert.throws(
    () =>
      validateCommandSurface({
        localeDescriptions: {
          es: {
            start: "Inicio",
            ghost_locale: "Sin controlador",
          },
        },
      }),
    (err) => {
      assert.ok(err instanceof CommandSurfaceValidationError);
      assert.ok(err.missingCommands.includes("ghost_locale"));
      assert.match(err.message, /\/ghost_locale/);
      return true;
    },
  );
});

test("validateCommandSurface rejects non-callable module handlers and undocumented non-hidden modules", () => {
  const brokenModules = registeredCommands().map((mod) =>
    mod.command === "status" ? { ...mod, handler: null } : mod,
  );

  assert.throws(
    () =>
      validateCommandSurface({
        modules: brokenModules,
        catalogueCommands: [...COMMAND_NAMES],
        helpDetails: COMMAND_DETAILS,
        menuMetadata: COMMANDS,
      }),
    (err) => {
      assert.ok(err instanceof CommandSurfaceValidationError);
      assert.ok(err.missingCommands.includes("status"));
      assert.match(err.message, /Command \/status is registered without a callable handler/);
      return true;
    },
  );

  assert.throws(
    () =>
      validateCommandSurface({
        modules: [
          ...registeredCommands(),
          { command: "undocumented_cmd", hidden: false, handler: async () => undefined },
        ],
        catalogueCommands: [...COMMAND_NAMES],
        helpDetails: COMMAND_DETAILS,
        menuMetadata: COMMANDS,
      }),
    (err) => {
      assert.ok(err instanceof CommandSurfaceValidationError);
      assert.ok(err.missingCommands.includes("undocumented_cmd"));
      assert.match(err.message, /\/undocumented_cmd/);
      return true;
    },
  );
});

test("registerCommandHandlers stops an invalid deployment when a registrar skips binding an advertised command", () => {
  const partialRegistrar = {
    command(name) {
      if (name === "pause") {
        return false;
      }
      return undefined;
    },
  };

  assert.throws(
    () => registerCommandHandlers(partialRegistrar, makeDeps()),
    (err) => {
      assert.ok(err instanceof CommandSurfaceValidationError);
      assert.ok(err.missingCommands.includes("pause"));
      assert.match(err.message, /\/pause/);
      return true;
    },
  );
});
