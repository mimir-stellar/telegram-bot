/**
 * Entry point: config -> RPC client -> bot -> poller.
 *
 * Startup is fail-fast (a bad config exits non-zero with the reasons listed);
 * everything after startup is fail-soft, because the whole point of this process
 * is to still be running next week.
 */

import { ConfigError, loadConfig, networkLabel } from "./config.js";
import { createBot, createNotifier, registerCommands } from "./bot.js";
import { createPoller } from "./poller.js";
import { createRpcServer } from "./stellar/client.js";
import { Logger } from "./logger.js";

/**
 * Installed before anything else can throw, so a rejection during startup is
 * reported rather than printed by Node as a bare stack trace.
 */
function installProcessHandlers(): void {
  // A rejected promise nobody awaited is a bug, but not a reason to stop
  // notifying. Log it and let the poll loop carry on.
  process.on("unhandledRejection", (reason) => {
    Logger.error("unhandled rejection", { reason: String(reason) });
  });

  // An uncaught exception means state is unknown; exit so the supervisor
  // restarts us. The persisted cursor is what makes that cheap.
  process.on("uncaughtException", (err) => {
    Logger.fatal("uncaught exception, exiting for restart", { error: String(err) });
    process.exit(1);
  });
}

async function main(): Promise<void> {
  installProcessHandlers();

  const config = loadConfig();

  Logger.info("boot", {
    service: "Mimir Telegram notifier",
    network: networkLabel(config),
    rpcUrl: config.rpcUrl,
    marketContractId: config.marketContractId,
    squadContractId: config.squadContractId,
    chatId: config.chatId,
    cursorFile: config.cursorFile,
  });

  const server = createRpcServer(config);

  // One read before announcing readiness: a wrong RPC URL should surface now,
  // not as a mystery in the poll log an interval later.
  const health = await server.getHealth();
  Logger.info("boot", {
    rpcOk: true,
    status: health.status,
    oldestLedger: health.oldestLedger,
    latestLedger: health.latestLedger,
  });

  // The bot needs the poller's status and the poller needs the bot's send path,
  // so one edge of the cycle is late-bound. This one, because it is the only
  // one that is a single function reference.
  let notify: (text: string) => Promise<void> = async () => {
    throw new Error("telegram notifier not ready");
  };

  const poller = createPoller({ config, server, send: (text) => notify(text) });
  const bot = createBot({ config, status: () => poller.status() });
  notify = createNotifier(bot, config);

  await registerCommands(bot);

  // grammy's `start` resolves only when the bot stops, so it is not awaited.
  // It retries transient network trouble internally; a rejection here means the
  // token itself cannot authenticate, which no amount of waiting fixes.
  void bot
    .start({
      onStart: (me) => Logger.info("boot", { telegramOk: true, username: me.username }),
    })
    .catch((err: unknown) => {
      Logger.fatal("telegram long-polling failed — check BOT_TOKEN", { error: String(err) });
      process.exit(1);
    });

  await poller.start();

  const shutdown = (signal: string) => {
    Logger.info("shutdown", { signal });
    poller.stop();
    void bot.stop().finally(() => process.exit(0));
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    Logger.error("boot", { configError: true, problems: err.problems });
    process.exit(1);
  }
  Logger.error("boot", { startupFailed: true, error: String(err) });
  process.exit(1);
});