/**
 * The grammy bot: commands, and the one send path the poller uses.
 *
 * The bot half is deliberately thin. It answers three commands and exposes
 * `notify()`; all chain logic lives in `src/poller.ts` and `src/stellar/`.
 */

import { Bot } from "grammy";

import { escapeMd } from "./notifications/format.js";
import { networkLabel, type BotConfig } from "./config.js";
import type { PollerStatus } from "./poller.js";
import {
  classifyTelegramError,
  MAX_RATE_LIMIT_WAIT_SECONDS,
} from "./telegramErrors.js";

const HELP = [
  "*Mimir notifier*",
  "",
  "I watch Mimir's two Soroban contracts on Stellar and post every new on-chain event here: claims opened, challenges staked, oracle resolutions, settlements and payouts\\.",
  "",
  "/status — what I am watching and how far I have read",
  "/help — this message",
].join("\n");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
}

export function createBot(deps: BotDeps): Bot {
  const { config, status } = deps;
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

  // grammy rethrows handler errors by default, which would take the process
  // with it. A malformed command must not be fatal.
  bot.catch((err) => {
    const classified = classifyTelegramError(err.error);
    console.error(
      `[bot] handler error on update ${err.ctx.update.update_id}: ${classified.safeMessage}`,
    );
  });

  return bot;
}

/**
 * The poller's send path: one message to the configured chat.
 *
 * On a 429 rate limit, waits up to {@link MAX_RATE_LIMIT_WAIT_SECONDS} and
 * retries once. All other failures are logged as classified kinds and rethrown
 * so the poller can drop that single message and keep the cursor moving.
 */
export function createNotifier(bot: Bot, config: BotConfig) {
  return async (text: string): Promise<void> => {
    const sendOnce = () =>
      bot.api.sendMessage(config.chatId, text, {
        parse_mode: "MarkdownV2",
        link_preview_options: { is_disabled: true },
      });

    try {
      await sendOnce();
    } catch (err) {
      const classified = classifyTelegramError(err);
      if (classified.kind === "rate_limit") {
        const waitSeconds = classified.retryAfterSeconds ?? 1;
        const waitMs = Math.min(waitSeconds, MAX_RATE_LIMIT_WAIT_SECONDS) * 1000;
        console.warn(
          `[bot] ${classified.safeMessage}; waiting ${waitMs}ms then retrying once`,
        );
        await sleep(waitMs);
        try {
          await sendOnce();
          return;
        } catch (retryErr) {
          const retryClassified = classifyTelegramError(retryErr);
          console.error(`[bot] send retry failed: ${retryClassified.safeMessage}`);
          throw retryErr;
        }
      }
      console.error(`[bot] send failed: ${classified.safeMessage}`);
      throw err;
    }
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
    const classified = classifyTelegramError(err);
    console.warn(`[bot] setMyCommands failed: ${classified.safeMessage}`);
  }
}

export { classifyTelegramError } from "./telegramErrors.js";
