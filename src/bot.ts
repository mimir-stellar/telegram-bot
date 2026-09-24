/**
 * The grammy bot: commands, and the one send path the poller uses.
 *
 * The bot half is deliberately thin. It answers commands and exposes
 * `notify()`; all chain logic lives in `src/poller.ts` and `src/stellar/`.
 */

import { Bot, type Context } from "grammy";

import { escapeMd } from "./notifications/format.js";
import { networkLabel, type BotConfig } from "./config.js";
import type { PollerStatus } from "./poller.js";

const HELP = [
  "*Mimir notifier*",
  "",
  "I watch Mimir's two Soroban contracts on Stellar and post every new on-chain event here: claims opened, challenges staked, oracle resolutions, settlements and payouts\\.",
  "",
  "/status — what I am watching and how far I have read",
  "/pause — operator only: suppress notifications \\(cursors still advance\\)",
  "/resume — operator only: send notifications again",
  "/help — this message",
].join("\n");

function ago(timestamp: number | null): string {
  if (timestamp === null) return "never";
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

function statusMessage(config: BotConfig, status: PollerStatus): string {
  const runLabel = status.paused
    ? "paused"
    : status.running
      ? "running"
      : "stopped";
  const lines: string[] = [
    `*Status* — ${runLabel} on Stellar ${networkLabel(config)}`,
    "",
    `Chain tip: ${status.latestLedger ?? "unknown"}`,
    `RPC retains from ledger: ${status.oldestLedger ?? "unknown"}`,
    `Poll interval: ${Math.round(config.pollIntervalMs / 1000)}s · last poll ${ago(status.lastPollAt)}`,
    `Cycles: ${status.cycles} · sent ${status.notificationsSent} · failed sends ${status.notificationsFailed} · skipped ${status.eventsSkipped}`,
    "",
    "*Watching*",
  ];

  for (const target of status.targets) {
    lines.push(
      `· mimir\\-\( {target.source} \` \){target.contractId}\``,
      `  last event ledger: ${target.lastEventLedger ?? "none seen"}`,
      `  cursor: \`${target.cursor ?? "none (cold start)"}\``,
    );
    if (target.lastError) lines.push(`  last error: ${escapeMd(target.lastError)}`);
  }

  if (status.lastError) {
    lines.push(
      "",
      `Last error \\(${ago(status.lastError.at)}\\): ${escapeMd(status.lastError.message)}`,
    );
  }
  if (status.consecutiveFailures > 0) {
    lines.push(`Consecutive failed cycles: ${status.consecutiveFailures}`);
  }

  return lines.join("\n");
}

function isOperator(config: BotConfig, ctx: Context): boolean {
  const fromId = ctx.from?.id;
  if (fromId === undefined) return false;
  return config.operatorUserIds.has(String(fromId));
}

export interface BotDeps {
  config: BotConfig;
  status: () => PollerStatus;
  pause: () => void;
  resume: () => void;
}

export function createBot(deps: BotDeps): Bot {
  const { config, status, pause, resume } = deps;
  const bot = new Bot(config.botToken);

  bot.command("start", async (ctx) => {
    await ctx.reply(HELP, { parse_mode: "MarkdownV2" });
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(HELP, { parse_mode: "MarkdownV2" });
  });

  bot.command("status", async (ctx) => {
    await ctx.reply(statusMessage(config, status()), {
      parse_mode: "MarkdownV2",
      link_preview_options: { is_disabled: true },
    });
  });

  bot.command("pause", async (ctx) => {
    if (!isOperator(config, ctx)) {
      await ctx.reply("Operator only\\.", { parse_mode: "MarkdownV2" });
      console.warn(
        `[bot] /pause denied for user ${ctx.from?.id ?? "unknown"} (not an operator)`,
      );
      return;
    }
    const before = status().paused;
    pause();
    const text = before
      ? "Already paused\\. Notifications remain suppressed; cursors still advance\\."
      : "Paused\\. Notifications suppressed; chain scans and cursors still advance\\. Use /resume when ready\\.";
    await ctx.reply(text, { parse_mode: "MarkdownV2" });
    console.log(`[bot] /pause by operator ${ctx.from?.id}`);
  });

  bot.command("resume", async (ctx) => {
    if (!isOperator(config, ctx)) {
      await ctx.reply("Operator only\\.", { parse_mode: "MarkdownV2" });
      console.warn(
        `[bot] /resume denied for user ${ctx.from?.id ?? "unknown"} (not an operator)`,
      );
      return;
    }
    const before = status().paused;
    resume();
    const text = before
      ? "Resumed\\. New events will be notified again\\."
      : "Already running\\. Notifications were not suppressed\\.";
    await ctx.reply(text, { parse_mode: "MarkdownV2" });
    console.log(`[bot] /resume by operator ${ctx.from?.id}`);
  });

  // grammy rethrows handler errors by default, which would take the process
  // with it. A malformed command must not be fatal.
  bot.catch((err) => {
    console.error(`[bot] handler error on update ${err.ctx.update.update_id}:`, err.error);
  });

  return bot;
}

/** The poller's send path: one message to the configured chat. */
export function createNotifier(bot: Bot, config: BotConfig) {
  return async (text: string): Promise<void> => {
    await bot.api.sendMessage(config.chatId, text, {
      parse_mode: "MarkdownV2",
      link_preview_options: { is_disabled: true },
    });
  };
}

/** Registers the command list so Telegram's UI offers autocompletion. */
export async function registerCommands(bot: Bot): Promise<void> {
  try {
    await bot.api.setMyCommands([
      { command: "start", description: "What this bot does" },
      { command: "help", description: "Show help" },
      { command: "status", description: "Last-seen ledger and watched contracts" },
      { command: "pause", description: "Operator: suppress notifications" },
      { command: "resume", description: "Operator: send notifications again" },
    ]);
  } catch (err) {
    // Cosmetic. Never worth failing a boot over.
    console.warn(`[bot] setMyCommands failed: ${err instanceof Error ? err.message : err}`);
  }
    }
