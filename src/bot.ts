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
  AUDIT_REPORT_MAX_ENTRIES,
  readAuditFile,
  renderAuditReport,
  type AuditFileSummary,
  type AuditLog,
} from "./audit.js";

const HELP = [
  "*Mimir notifier*",
  "",
  "I watch Mimir's two Soroban contracts on Stellar and post every new on-chain event here: claims opened, challenges staked, oracle resolutions, settlements and payouts\\.",
  "",
  "/status — what I am watching and how far I have read",
  "/audit — the operator audit report, redacted and bounded",
  "/help — this message",
].join("\n");

function ago(timestamp: number | null): string {
  if (timestamp === null) return "never";
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

const AUDIT_COMMAND_HINT = "See `npm run audit -- --help` for the standalone report tool.";

/**
 * Render the audit report for Telegram. The report is plain text — audit lines
 * are arbitrary redacted strings and MarkdownV2 would mangle them — so nothing
 * here goes through MarkdownV2 escaping; this message is sent without a parse
 * mode. Bounded twice over: the file read is capped and only the tail renders.
 */
function renderAuditForTelegram(summary: AuditFileSummary, tail: number): string {
  const header = `*Audit* — ${summary.file}`;
  const report = renderAuditReport(summary, { tail });
  return `${header}\n\n${report}\n\n${AUDIT_COMMAND_HINT}`;
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
  /** Live in-memory audit window; renders immediately even before a flush. */
  audit?: AuditLog | undefined;
  /** Where the audit JSONL file lives, for the file-backed report. */
  auditFile?: string | undefined;
}

/** How many recent audit lines `/audit` renders. A chat message is not a file. */
const AUDIT_TAIL = 10;

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

  bot.command("audit", async (ctx) => {
    try {
      const file = deps.auditFile ?? config.auditFile;
      const summary = await readAuditFile(file);

      // The in-memory window also holds entries recorded since the last flush;
      // append any of those the file does not already contain (same entries
      // serialise identically) so the report is current without duplicates.
      const seen = new Set(summary.entries.map((e) => JSON.stringify(e)));
      const live = (deps.audit ? deps.audit.tail(AUDIT_TAIL) : []).filter(
        (e) => !seen.has(JSON.stringify(e)),
      );

      const merged: AuditFileSummary = {
        ...summary,
        entries: [...summary.entries, ...live].slice(-AUDIT_REPORT_MAX_ENTRIES),
      };
      await ctx.reply(renderAuditForTelegram(merged, AUDIT_TAIL), {
        link_preview_options: { is_disabled: true },
      });
    } catch (err) {
      await ctx.reply(`Audit report failed: ${err instanceof Error ? err.message : String(err)}`);
    }
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
      { command: "audit", description: "Operator audit report (redacted, bounded)" },
    ]);
  } catch (err) {
    // Cosmetic. Never worth failing a boot over.
    console.warn(`[bot] setMyCommands failed: ${err instanceof Error ? err.message : err}`);
  }
}
