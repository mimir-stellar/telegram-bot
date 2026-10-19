/**
 * The grammy bot: commands, and the one send path the poller uses.
 *
 * The bot half is deliberately thin. It answers public status and contract
 * commands plus operator pause/resume controls. Operator controls only change
 * when the next polling cycle starts; they never edit cursors or touch chain
 * state. All chain logic lives in `src/poller.ts` and `src/stellar/`.
 */

import { Bot, InlineKeyboard, type Context } from "grammy";
import type { UserFromGetMe } from "grammy/types";

import { escapeMd, previewMessage, safeErrorMessage } from "./notifications/format.js";
export { previewMessage } from "./notifications/format.js";
import { networkLabel, type BotConfig } from "./config.js";
import { contractExplorerUrl } from "./stellar/client.js";
import { buildHealthReport } from "./health.js";
import type { PollerPauseResult, PollerResumeResult, PollerStatus } from "./poller.js";

/**
 * How long a pause-confirmation message stays valid.
 * Callbacks arriving after this window are rejected as stale.
 */
export const PAUSE_CONFIRM_TTL_MS = 60_000;

/**
 * The two callback_data strings used by the pause confirmation flow.
 * Both are well under Telegram's 64-byte limit.
 */
export const CALLBACK_PAUSE_CONFIRM = "pause-confirm" as const;
export const CALLBACK_PAUSE_CANCEL = "pause-cancel" as const;

type ValidCallbackAction = typeof CALLBACK_PAUSE_CONFIRM | typeof CALLBACK_PAUSE_CANCEL;

const VALID_CALLBACK_DATA = new Set<string>([
  CALLBACK_PAUSE_CONFIRM,
  CALLBACK_PAUSE_CANCEL,
]);

/**
 * Returns the validated action string or `null` if data is unknown/missing.
 * Keeps the handler from acting on arbitrary payloads from third parties.
 */
export function validateCallbackData(data: string | undefined): ValidCallbackAction | null {
  if (data !== undefined && VALID_CALLBACK_DATA.has(data)) {
    return data as ValidCallbackAction;
  }
  return null;
}

/** Inline keyboard attached to the pause confirmation message. */
export function operatorKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Confirm pause", CALLBACK_PAUSE_CONFIRM)
    .text("❌ Cancel", CALLBACK_PAUSE_CANCEL);
}

const HELP_BASE = [
  "*Mimir notifier*",
  "",
  "I watch Mimir's two Soroban contracts on Stellar and post every new on-chain event here: claims opened, challenges staked, oracle resolutions, settlements and payouts\\.",
  "",
  "/status — what I am watching and how far I have read",
  "/contracts — the contract ids I watch and where to look them up",
  "/health — health assessment and operational readiness",
  "/preview — preview channel notification formatting",
  "/help — this message",
];

function helpMessage(config: BotConfig): string {
  if (config.operatorTelegramUserId === null) return HELP_BASE.join("\n");
  return [
    ...HELP_BASE.slice(0, -1),
    "/pause — operator only: pause scheduling new scans",
    "/resume — operator only: resume polling now",
    HELP_BASE.at(-1) as string,
  ].join("\n");
}

const TELEGRAM_OPTIONS = {
  parse_mode: "MarkdownV2" as const,
  link_preview_options: { is_disabled: true },
};

function ago(timestamp: number | null, nowMs: number = Date.now()): string {
  if (timestamp === null) return "never";
  const seconds = Math.max(0, Math.round((nowMs - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

function cursorPreview(cursor: string | null): string {
  if (cursor === null) return "none (cold start)";
  const compact = cursor.replace(/\s+/g, " ").replace(/[`\\]/g, "?").trim() || "empty";
  return compact.length <= 24 ? compact : `${compact.slice(0, 23)}…`;
}

function statusMessage(config: BotConfig, status: PollerStatus, nowMs: number = Date.now()): string {
  const lines: string[] = [
    `*Status* — ${status.paused ? "paused" : status.running ? "running" : "stopped"} on Stellar ${networkLabel(config)}`,
    `Channel preview: ${config.channelPreviewMode ? "enabled" : "disabled"}`,
    "",
    `Chain tip: ${status.latestLedger ?? "unknown"}`,
    `RPC retains from ledger: ${status.oldestLedger ?? "unknown"}`,
    `Poll interval: ${Math.round(config.pollIntervalMs / 1000)}s · last poll ${ago(status.lastPollAt, nowMs)}`,
    `Cycles: ${status.cycles} · sent ${status.notificationsSent} · failed sends ${status.notificationsFailed} · skipped ${status.eventsSkipped}`,
    "",
    "*Watching*",
  ];

  for (const target of status.targets) {
    lines.push(
      `· mimir\\-${target.source} \`${target.contractId}\``,
      `  last event ledger: ${target.lastEventLedger ?? "none seen"}`,
      `  cursor: \`${cursorPreview(target.cursor)}\``,
    );
    if (target.lastError) lines.push(`  last error: ${escapeMd(target.lastError)}`);
  }

  if (status.lastError) {
    lines.push(
      "",
      `Last error \\(${ago(status.lastError.at, nowMs)}\\): ${escapeMd(status.lastError.message)}`,
    );
  }
  if (status.consecutiveFailures > 0) {
    lines.push(`Consecutive failed cycles: ${status.consecutiveFailures}`);
  }

  return lines.join("\n");
}

/**
 * The `/contracts` message: which two contracts this bot watches, and where to
 * look each one up independently — deliberately static (config only, no
 * poller state), so it answers the same whether the poller is mid-cycle,
 * between restarts, or wedged on a run of RPC failures. `/status` is for
 * "is it working"; this is for "what is it even watching".
 */
export function healthMessage(
  config: BotConfig,
  status: PollerStatus,
  nowMs: number = Date.now(),
): string {
  const report = buildHealthReport(config, status, nowMs);
  const statusLabel = report.status.toUpperCase();

  const lines: string[] = [
    `*Health* — ${escapeMd(statusLabel)} on Stellar ${networkLabel(config)}`,
    "",
    `Status: \`${report.status}\` \\(${report.ok ? "ok" : "action required"}\\)`,
    `Poller: ${report.poller.running ? "running" : "stopped"}`,
    `Uptime: ${report.uptimeMs > 0 ? ago(nowMs - report.uptimeMs, nowMs) : "0s"}`,
    `Poll interval: ${Math.round(config.pollIntervalMs / 1000)}s · last poll ${ago(status.lastPollAt, nowMs)}`,
    `Last successful poll: ${ago(status.lastSuccessAt, nowMs)}`,
    `Chain tip: ${report.poller.latestLedger ?? "unknown"}`,
    `Cycles: ${report.poller.cycles} · consecutive failures: ${report.poller.consecutiveFailures}`,
    `Notifications: sent ${report.poller.notificationsSent} · failed ${report.poller.notificationsFailed} · skipped ${report.poller.eventsSkipped}`,
    "",
    "*Watched Contracts*",
  ];

  for (const target of report.poller.targets) {
    lines.push(
      `· mimir\\-${target.source} \`${target.contractId}\``,
      `  last event ledger: ${target.lastEventLedger ?? "none seen"}`,
      `  cursor: \`${target.cursorPreview ?? "none (cold start)"}\``,
    );
    if (target.hasError) {
      const targetState = status.targets.find((t) => t.source === target.source);
      if (targetState?.lastError) {
        lines.push(`  last error: ${escapeMd(targetState.lastError)}`);
      }
    }
  }

  if (report.poller.lastError) {
    lines.push(
      "",
      `Last error \\(${ago(status.lastError?.at ?? null, nowMs)}\\): ${escapeMd(report.poller.lastError.message)}`,
    );
  }

  return lines.join("\n");
}

export function contractsMessage(config: BotConfig): string {
  const targets: Array<{ label: string; contractId: string }> = [
    { label: "mimir\\-market", contractId: config.marketContractId },
    { label: "mimir\\-squad", contractId: config.squadContractId },
  ];

  const lines: string[] = [
    `*Contracts* — Mimir on Stellar ${escapeMd(networkLabel(config))}`,
    "",
    "Read\\-only: this bot holds no signing keys and cannot submit transactions\\.",
  ];

  for (const target of targets) {
    lines.push(
      "",
      `*${target.label}*`,
      `\`${escapeMd(target.contractId)}\``,
      `[View on stellar\\.expert](${contractExplorerUrl(config, target.contractId)})`,
    );
  }

  return lines.join("\n");
}

/** Exact operator replies, exported for deterministic Telegram payload tests. */
export function pauseMessage(result: PollerPauseResult): string {
  switch (result) {
    case "paused":
      return "*Polling paused*\nThe current scan may finish, but no new cycle will start\\. Cursors were not changed\\.";
    case "already-paused":
      return "*Polling is already paused*";
    case "stopped":
      return "*Polling cannot pause* — the process is stopping\\.";
  }
}

export function resumeMessage(result: PollerResumeResult): string {
  switch (result) {
    case "resumed":
      return "*Polling resumed*\nThe next scan starts now\\. Cursors were not changed\\.";
    case "already-running":
      return "*Polling is already running*";
    case "stopped":
      return "*Polling cannot resume* — the process is stopping\\.";
  }
}

/**
 * Shared handler for pause inline-keyboard callbacks.
 *
 * Exported for unit testing without needing a live grammy `Bot` instance.
 * Callers must pass a grammy-compatible `ctx` that exposes:
 *   - `ctx.from`
 *   - `ctx.callbackQuery.data`
 *   - `ctx.callbackQuery.message.date` (Unix seconds, set by Telegram)
 *   - `ctx.answerCallbackQuery(text?, opts?)`
 *   - `ctx.editMessageText(text, opts)`
 */
export async function handleCallbackQuery(
  ctx: Context,
  deps: Pick<BotDeps, "config" | "pause">,
  nowMs: number = Date.now(),
): Promise<void> {
  const { config, pause } = deps;

  const action = validateCallbackData(ctx.callbackQuery?.data);
  if (action === null) return; // unknown payload — silently ignore

  // Only the operator may act on these buttons.
  if (!isOperator(ctx, config)) {
    await ctx.answerCallbackQuery({ text: "Only the operator can do that.", show_alert: true });
    return;
  }

  // Reject stale confirmations so an old message cannot pause the bot later.
  const messageDate = ctx.callbackQuery?.message?.date ?? 0;
  const ageMs = nowMs - messageDate * 1000;
  if (ageMs > PAUSE_CONFIRM_TTL_MS) {
    await ctx.answerCallbackQuery({ text: "Confirmation expired.", show_alert: true });
    await ctx.editMessageText("⏱ *Pause confirmation expired\\.* Run /pause again\\.", TELEGRAM_OPTIONS);
    return;
  }

  if (action === CALLBACK_PAUSE_CONFIRM) {
    const result = pause();
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(pauseMessage(result), TELEGRAM_OPTIONS);
    return;
  }

  if (action === CALLBACK_PAUSE_CANCEL) {
    await ctx.answerCallbackQuery({ text: "Cancelled." });
    await ctx.editMessageText("*Pause cancelled\\.* Polling continues\\.", TELEGRAM_OPTIONS);
    return;
  }
}

export interface BotDeps {
  config: BotConfig;
  status: () => PollerStatus;
  /**
   * Pre-populated bot info. When provided (e.g. in tests) grammy skips the
   * getMe() call so `bot.handleUpdate()` works without a real Telegram token.
   */
  botInfo?: UserFromGetMe;
  pause: () => PollerPauseResult;
  resume: () => PollerResumeResult;
}

/**
 * Returns true when the chat is permitted to use restricted commands.
 *
 * Rules:
 * - If `allowedChatIds` is empty the list is open (any chat may use /status).
 * - Otherwise the incoming chat id must appear in the list. Both the numeric
 *   id (stored as a number in grammy's ctx.chat.id) and its string form are
 *   compared so that negative group ids such as -1001234567890 match correctly.
 */
function isChatAllowed(allowedChatIds: string[], chatId: number): boolean {
  if (allowedChatIds.length === 0) return true;
  const asString = String(chatId);
  return allowedChatIds.some((allowed) => allowed === asString);
}

function isOperator(ctx: Context, config: BotConfig): boolean {
  const operatorId = config.operatorTelegramUserId;
  return operatorId !== null && ctx.from?.id.toString() === operatorId;
}

/** Register command handlers on a grammy-compatible bot (also useful in tests). */
export function registerCommandHandlers(bot: Bot, deps: BotDeps): void {
  const { config, status, pause, resume } = deps;

  bot.command("start", async (ctx) => {
    await ctx.reply(helpMessage(config), TELEGRAM_OPTIONS);
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(helpMessage(config), TELEGRAM_OPTIONS);
  });

  bot.command("status", async (ctx) => {
    if (!isChatAllowed(config.allowedChatIds, ctx.chat.id)) {
      // Silently ignore requests from unapproved chats. Responding with an
      // error would leak the existence of the restriction; not responding at
      // all is consistent with privacy-mode bots that simply never see most
      // messages. Log so operators can diagnose misconfigured chat ids.
      console.warn(
        `[bot] /status denied for chat ${ctx.chat.id} (not in ALLOWED_CHAT_IDS)`,
      );
      return;
    }
    await ctx.reply(statusMessage(config, status()), TELEGRAM_OPTIONS);
  });

  // Config-only, so this never fails on account of poller or RPC state —
  // unlike /status, it has nothing to report failure on.
  bot.command("health", async (ctx) => {
    await ctx.reply(healthMessage(config, status()), TELEGRAM_OPTIONS);
  });

  bot.command("contracts", async (ctx) => {
    await ctx.reply(contractsMessage(config), TELEGRAM_OPTIONS);
  });

  bot.command("preview", async (ctx) => {
    const text = ctx.message?.text ?? "";
    const spaceIndex = text.indexOf(" ");
    const arg = spaceIndex !== -1 ? text.slice(spaceIndex + 1).trim() : "";
    await ctx.reply(previewMessage(config, arg || "market"), TELEGRAM_OPTIONS);
  });

  bot.command("pause", async (ctx) => {
    if (!isOperator(ctx, config)) {
      console.warn(`[bot] ignored unauthorized /pause on update ${ctx.update.update_id}`);
      return;
    }
    await ctx.reply(
      "⏸ *Pause polling?*\nThis will stop new scans from starting\\. The current scan may finish\\.",
      { ...TELEGRAM_OPTIONS, reply_markup: operatorKeyboard() },
    );
  });

  bot.command("resume", async (ctx) => {
    if (!isOperator(ctx, config)) {
      console.warn(`[bot] ignored unauthorized /resume on update ${ctx.update.update_id}`);
      return;
    }
    await ctx.reply(resumeMessage(resume()), TELEGRAM_OPTIONS);
  });

  // Inline-keyboard callbacks for the pause confirmation flow.
  bot.callbackQuery(
    [CALLBACK_PAUSE_CONFIRM, CALLBACK_PAUSE_CANCEL],
    async (ctx) => handleCallbackQuery(ctx, { config, pause }),
  );
}

export function createBot(deps: BotDeps): Bot {
  const bot = new Bot(deps.config.botToken, deps.botInfo !== undefined ? { botInfo: deps.botInfo } : undefined);
  registerCommandHandlers(bot, deps);

  // grammy rethrows handler errors by default, which would take the process
  // with it. Keep Telegram/RPC error text bounded and redact known secrets.
  bot.catch((err) => {
    console.error(
      `[bot] handler error on update ${err.ctx.update.update_id}: ` +
        safeErrorMessage(err.error, [deps.config.botToken]),
    );
  });

  return bot;
}

/** The poller's send path: one message to the configured chat. */
export function createNotifier(bot: Bot, config: BotConfig) {
  return async (text: string): Promise<void> => {
    await bot.api.sendMessage(config.chatId, text, TELEGRAM_OPTIONS);
  };
}

/** Registers the command list so Telegram's UI offers autocompletion. */
export async function registerCommands(bot: Bot): Promise<void> {
  try {
    await bot.api.setMyCommands([
      { command: "start", description: "What this bot does" },
      { command: "help", description: "Show help" },
      { command: "status", description: "Last-seen ledger and watched contracts" },
      { command: "contracts", description: "Contract ids and explorer links" },
      { command: "health", description: "Health assessment and operational readiness" },
      { command: "preview", description: "Preview channel notification formatting" },
      { command: "pause", description: "Operator only: pause new scans" },
      { command: "resume", description: "Operator only: resume polling now" },
    ]);
  } catch (err) {
    // Cosmetic. Never worth failing a boot over, and never log an unbounded API error.
    console.warn(`[bot] setMyCommands failed: ${safeErrorMessage(err)}`);
  }
}

