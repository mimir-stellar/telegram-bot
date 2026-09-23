/**
 * Entry point: config -> RPC client -> bot -> poller -> optional health server.
 *
 * Startup is fail-fast (a bad config exits non-zero with the reasons listed);
 * everything after startup is fail-soft, because the whole point of this process
 * is to still be running next week.
 *
 * ── Exit codes ───────────────────────────────────────────────────────────────
 *
 *  0  Clean shutdown (SIGTERM / SIGINT).
 *  1  Fatal startup error or uncaught exception; fix the cause before restarting.
 *  2  Telegram token rejected; replace BOT_TOKEN before restarting.
 *  3  Persistent Stellar RPC failure; supervisor may restart automatically.
 *
 * See src/exitCodes.ts for the full taxonomy.
 *
 * ── SIGHUP ───────────────────────────────────────────────────────────────────
 *
 * Sending SIGHUP stops the poller and bot cleanly then exits with code 0, so
 * the supervisor can re-exec the process (e.g. after a binary update) without
 * triggering an error-restart path. It is intentionally identical to a clean
 * shutdown from the supervisor's perspective.
 *
 * ── HTTP health endpoint (/healthz) ──────────────────────────────────────────
 *
 * When HTTP_HEALTH_PORT > 0 a minimal HTTP/1.1 server listens on that port.
 *
 *   GET /healthz
 *     200 {"ok":true}  — poller succeeded within the last 3 × pollIntervalMs
 *     503 {"ok":false} — stale or never succeeded
 *
 * All other paths return 404. The server is intentionally read-only (GET only).
 */

import { createServer } from "node:http";

import { ConfigError, loadConfig, networkLabel } from "./config.js";
import { EXIT_OK, EXIT_ERROR, EXIT_BAD_TOKEN } from "./exitCodes.js";
import { createBot, createNotifier, registerCommands } from "./bot.js";
import { createPoller } from "./poller.js";
import { createRpcServer } from "./stellar/client.js";

/**
 * Installed before anything else can throw, so a rejection during startup is
 * reported rather than printed by Node as a bare stack trace.
 */
function installProcessHandlers(): void {
  // A rejected promise nobody awaited is a bug, but not a reason to stop
  // notifying. Log it and let the poll loop carry on.
  process.on("unhandledRejection", (reason) => {
    console.error("[error] unhandled rejection:", reason);
  });

  // An uncaught exception means state is unknown; exit so the supervisor
  // restarts us. The persisted cursor is what makes that cheap.
  process.on("uncaughtException", (err) => {
    console.error("[fatal] uncaught exception, exiting for restart:", err);
    process.exit(EXIT_ERROR);
  });
}

async function main(): Promise<void> {
  installProcessHandlers();

  const config = loadConfig();

  console.log(`[boot] Mimir Telegram notifier`);
  console.log(`[boot] network      ${networkLabel(config)} (${config.rpcUrl})`);
  console.log(`[boot] market       ${config.marketContractId}`);
  console.log(`[boot] squad        ${config.squadContractId}`);
  console.log(`[boot] chat         ${config.chatId}`);
  console.log(`[boot] cursor file  ${config.cursorFile}`);
  if (config.consecutiveFailureExitThreshold > 0) {
    console.log(`[boot] exit on      ${config.consecutiveFailureExitThreshold} consecutive failures (code 3)`);
  }

  const server = createRpcServer(config);

  // One read before announcing readiness: a wrong RPC URL should surface now,
  // not as a mystery in the poll log an interval later.
  const health = await server.getHealth();
  console.log(
    `[boot] rpc ok, status=${health.status} ledgers ${health.oldestLedger}..${health.latestLedger}`,
  );

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
      onStart: (me) => console.log(`[boot] telegram ok, running as @${me.username}`),
    })
    .catch((err: unknown) => {
      console.error("[fatal] telegram long-polling failed — check BOT_TOKEN:", err);
      process.exit(EXIT_BAD_TOKEN);
    });

  await poller.start();

  // ── Optional HTTP health endpoint ──────────────────────────────────────────

  if (config.httpHealthPort > 0) {
    const healthServer = createServer((req, res) => {
      if (req.method !== "GET" || req.url !== "/healthz") {
        res.writeHead(404, { "Content-Type": "application/json" }).end('{"ok":false}');
        return;
      }

      const s = poller.status();
      const staleness = config.pollIntervalMs * 3;
      const ok =
        s.lastSuccessAt !== null &&
        Date.now() - s.lastSuccessAt < staleness &&
        !s.anyStaleCursor;

      res
        .writeHead(ok ? 200 : 503, { "Content-Type": "application/json" })
        .end(JSON.stringify({ ok }));
    });

    healthServer.listen(config.httpHealthPort, () => {
      console.log(`[boot] health endpoint: http://0.0.0.0:${config.httpHealthPort}/healthz`);
    });

    // Health server errors (e.g. port already in use) are non-fatal: log and
    // continue. The notifier's core job does not depend on it.
    healthServer.on("error", (err) => {
      console.error(`[health] server error: ${err.message}`);
    });
  }

  // ── Signal handlers ────────────────────────────────────────────────────────

  const shutdown = (signal: string) => {
    console.log(`[shutdown] ${signal} received, stopping`);
    poller.stop();
    void bot.stop().finally(() => process.exit(EXIT_OK));
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  // SIGHUP: graceful stop + exit 0 so the supervisor can re-exec (e.g. after
  // deploying a new binary). Semantically identical to a clean shutdown.
  process.once("SIGHUP", () => shutdown("SIGHUP"));
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    console.error(`\n${err.message}\n`);
    process.exit(EXIT_ERROR);
  }
  console.error("[boot] startup failed:", err);
  process.exit(EXIT_ERROR);
});
