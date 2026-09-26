/**
 * The grammy bot: commands, and the one send path the poller uses.
 *
 * The bot half is deliberately thin. It answers three commands and exposes
 * `notify()`; all chain logic lives in `src/poller.ts` and `src/stellar/`.
 */

import { Bot } from "grammy";
import type { UserFromGetMe } from "grammy/types";

import { escapeMd } from "./notifications/format.js";
import { networkLabel, type BotConfig } from "./config.js";
import type { PollerStatus } from "./poller.js";

const HELP = [
  "*Mimir notifier*",
  "",
  "I watch Mimir's two Soroban contracts on Stellar and post every new on-chain event here: claims opened, challenges staked, oracle resolutions, settlements and payouts\\.",
  "",
  "/status — what I am watching and how far I have read",
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
  const lines: string[] = [
    `*Status* — ${status.running ? "running" : "stopped"} on Stellar ${networkLabel(config)}`,
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
      `· mimir\\-${target.source} \`${target.contractId}\``,
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

export interface BotDeps {
  config: BotConfig;
  status: () => PollerStatus;
  /**
   * Pre-populated bot info. When provided (e.g. in tests) grammy skips the
   * getMe() call so `bot.handleUpdate()` works without a real Telegram token.
   */
  botInfo?: UserFromGetMe;
}

/**
 * Returns true when the chat may interact with the bot.
 *
 * Rules:
 * - If `allowedChatIds` is empty the list is open (any chat may use commands).
 * - Otherwise the incoming chat id must appear in the list. Both the numeric
 *   id (grammy's ctx.chat.id) and its string form are compared so negative
 *   group ids such as -1001234567890 match correctly.
 */
export function isChatAllowed(allowedChatIds: string[], chatId: number): boolean {
  if (allowedChatIds.length === 0) return true;
  const asString = String(chatId);
  return allowedChatIds.some((allowed) => allowed === asString);
}

export function createBot(deps: BotDeps): Bot {
  const { config, status } = deps;
  const bot = new Bot(
    config.botToken,
    deps.botInfo !== undefined ? { botInfo: deps.botInfo } : undefined,
  );

  // Enforce the chat allowlist for every update that has a chat. When
  // ALLOWED_CHAT_IDS is set, unapproved chats are silently dropped so
  // /start, /help, /status (and any future commands) stay locked down.
  // Empty allowlist = open (no change for existing deployments).
  bot.use(async (ctx, next) => {
    const chat = ctx.chat;
    if (chat !== undefined && !isChatAllowed(config.allowedChatIds, chat.id)) {
      console.warn(
        `[bot] update denied for chat ${chat.id} (not in ALLOWED_CHAT_IDS)`,
      );
      return;
    }
    await next();
  });

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
    ]);
  } catch (err) {
    // Cosmetic. Never worth failing a boot over.
    console.warn(`[bot] setMyCommands failed: ${err instanceof Error ? err.message : err}`);
  }
}
