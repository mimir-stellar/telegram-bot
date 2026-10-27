/**
 * Localization strings for the Mimir Telegram notifier.
 *
 * All user-facing text lives here. Callers interpolate dynamic values (ledger
 * numbers, addresses, amounts) at the call site — the localization layer
 * provides the template; the caller provides the variables.
 *
 * ── Choosing a language ─────────────────────────────────────────────────────
 * `MIMIR_LOCALE` selects the locale (`en` or `es`; unset means `en`). The
 * selected locale is carried on the config as `config.locale`, so the bot and
 * the formatters render every message in it. Import the named English exports
 * below only when you explicitly want the reference language; product code
 * should use {@link messagesFor} with the configured locale.
 *
 * The named exports (`HELP_TITLE`, `NOTIFICATION_MD`, ...) remain the English
 * strings for backwards compatibility, and are also available as
 * `messagesFor("en")`.
 *
 * ── MarkdownV2 notes ────────────────────────────────────────────────────────
 * Static strings that will be sent to Telegram via MarkdownV2 are stored
 * pre-escaped where they contain reserved characters. Dynamic interpolations
 * are the caller's responsibility and must pass through `escapeMd` before
 * being spliced in. Plain-text strings (used without a parse_mode) are stored
 * as-is; they never contain Markdown syntax.
 *
 * ── Adding a string ─────────────────────────────────────────────────────────
 * 1. Add the key to the relevant template interface below.
 * 2. Add the English string to the matching constant.
 * 3. Add the translation to every locale entry in `MESSAGES` (TypeScript
 *    rejects a missing or malformed entry).
 * 4. Replace the inline literal in the source file with a reference through
 *    `messagesFor(locale)`.
 * 5. Add a test in tests/i18n.test.mjs that imports the key and asserts both
 *    the value and that the caller substitutes dynamic parts correctly.
 *
 * ── Adding a language ───────────────────────────────────────────────────────
 * 1. Add the code to `SUPPORTED_LOCALES` and a label to `LOCALE_LABELS`.
 * 2. Implement `Messages` for it (typically by copying `EN_MESSAGES` and
 *    translating every string, keeping the MarkdownV2 escaping rules).
 * 3. Register it in `MESSAGES`; the compiler then enforces completeness.
 */

// ── Locale registry ──────────────────────────────────────────────────────────

/** Locales this build can render. Add a code here and to `MESSAGES`. */
export const SUPPORTED_LOCALES = ["en", "es"] as const;

/** A locale this build can render. */
export type Locale = (typeof SUPPORTED_LOCALES)[number];

/** Locale used when `MIMIR_LOCALE` is unset. */
export const DEFAULT_LOCALE: Locale = "en";

/** Human-readable name of each locale, for docs and error messages. */
export const LOCALE_LABELS: Readonly<Record<Locale, string>> = {
  en: "English",
  es: "Español",
};

/**
 * Normalize an operator-supplied locale tag.
 *
 * Accepts case and region variants (`es`, `ES`, `es-ES`, `es_MX`) and maps them
 * to a supported base locale. Returns null when the language is unsupported, so
 * config loading can fail fast instead of silently rendering English.
 */
export function normalizeLocale(value: string): Locale | null {
  const base = value.trim().toLowerCase().split(/[-_]/, 1)[0] ?? "";
  return (SUPPORTED_LOCALES as readonly string[]).includes(base) ? (base as Locale) : null;
}

/** True when `value` is exactly a supported locale code. */
export function isLocale(value: string): value is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

// ── Bot: help and lifecycle (English reference strings) ──────────────────────

/** Help title (MarkdownV2). */
export const HELP_TITLE = "*Mimir notifier*";

/**
 * Help intro (plain text). The caller escapes it with `escapeMd`; the command
 * lines are generated from the command registry and COMMAND_DESCRIPTIONS.
 */
export const HELP_INTRO =
  "I watch Mimir's two Soroban contracts on Stellar and post every new on-chain event here: claims opened, challenges staked, oracle resolutions, settlements and payouts.";

// ── Bot: operator controls (MarkdownV2) ─────────────────────────────────────

export const PAUSE_MESSAGES = {
  paused:
    "*Polling paused*\nThe current scan may finish, but no new cycle will start\\. Cursors were not changed\\.",
  alreadyPaused: "*Polling is already paused*",
  stopped: "*Polling cannot pause* — the process is stopping\\.",
} as const;

export const RESUME_MESSAGES = {
  resumed: "*Polling resumed*\nThe next scan starts now\\. Cursors were not changed\\.",
  alreadyRunning: "*Polling is already running*",
  stopped: "*Polling cannot resume* — the process is stopping\\.",
} as const;

// ── Bot: audit command ───────────────────────────────────────────────────────

/**
 * Hint displayed after the audit report, pointing operators to the standalone
 * CLI. Plain text (the audit reply has no parse_mode).
 */
export const AUDIT_CLI_HINT =
  "See `npm run audit -- --help` for the standalone report tool.";

// ── Telegram command descriptions (shown in the UI autocomplete) ─────────────

/** Every command the bot registers, in menu order. */
export const COMMAND_NAMES = [
  "start",
  "help",
  "about",
  "status",
  "audit",
  "contracts",
  "health",
  "preview",
  "pause",
  "resume",
] as const;

/** A registered command name. */
export type CommandName = (typeof COMMAND_NAMES)[number];

/** Descriptions registered with `setMyCommands`. */
export const COMMAND_DESCRIPTIONS: Readonly<Record<CommandName, string>> = {
  start: "What this bot does",
  help: "Show help",
  about: "About this bot",
  status: "Last-seen ledger and watched contracts",
  audit: "Operator only: audit report (redacted, bounded)",
  contracts: "Contract ids and explorer links",
  health: "Health assessment and operational readiness",
  preview: "Preview channel notification formatting",
  pause: "Operator only: pause new scans",
  resume: "Operator only: resume polling now",
} as const;

// ── Notification template interfaces ─────────────────────────────────────────

/**
 * MarkdownV2 notification headlines. Every dynamic value is supplied by the
 * caller and must already be `escapeMd`-escaped before being passed in. Static
 * reserved characters inside the templates are pre-escaped in each locale.
 */
export interface NotificationMarkdownTemplates {
  // ── mimir-market ────────────────────────────────────────────────────────
  claimCreated(claimId: string, category: string, creator: string): string;
  claimChallenged(claimId: string, stake: string, challenger: string): string;
  claimResolved(
    claimId: string,
    winnerSide: string,
    confidence: string,
    summary: string | null,
  ): string;
  claimCancelled(claimId: string): string;
  marketSettled(
    claimId: string,
    totalPaid: string,
    totalFees: string,
    owedToChallengers: string,
    ...rest: (readonly string[] | string | undefined)[]
  ): string;
  challengerPaid(
    claimId: string,
    challenger: string,
    stake: string,
    net: string,
    gross: string,
    fee: string,
  ): string;
  feeClaimed(amount: string, recipient: string): string;
  withdrawal(amount: string, to: string): string;
  withdrawalPending(amount: string, to: string): string;

  // ── mimir-squad ─────────────────────────────────────────────────────────
  marketCreated(
    marketId: string,
    question: string,
    captain: string,
    feeBps: string,
    deadline: string,
    category?: string | null,
  ): string;
  deposited(marketId: string, amount: string, side: string, participant: string): string;
  withdrawn(marketId: string, participant: string, amount: string, side: string): string;
  resolved(marketId: string, result: string, poolA: string, poolB: string): string;
  /** Gross payout per 1 USDC staked on the winning side (squad `resolved`). */
  resolvedPayout(ratio: string): string;
  /** Squad `resolved` whose winning side has no stake, so no ratio exists. */
  resolvedNoWinningStake(side: string): string;
  claimed(
    marketId: string,
    participant: string,
    net: string,
    gross: string,
    fee: string,
  ): string;
  feesClaimedSquad(amount: string, recipient: string): string;

  // ── Fallback and preview ────────────────────────────────────────────────
  /**
   * Sent when an event payload is malformed or the formatter throws.
   * All parameters must already be escapeMd-escaped.
   */
  fallbackEvent(
    source: string,
    contract: string,
    ledger: string,
    reason: string,
    txPart: string,
  ): string;
  previewModePrefix: string;
  channelPreviewMarket: string;
  channelPreviewSquad: string;
}

/** Plain-text notification headlines, used without a parse_mode. */
export interface NotificationPlainTemplates {
  // ── mimir-market ────────────────────────────────────────────────────────
  claimCreated(claimId: string | number, category: string, creator: string): string;
  claimChallenged(
    claimId: string | number,
    stake: string,
    challenger: string,
  ): string;
  claimResolved(
    claimId: string | number,
    winnerSide: string,
    confidence: string,
    summary: string | null,
  ): string;
  claimCancelled(claimId: string | number): string;
  marketSettled(
    claimId: string | number,
    totalPaid: string,
    totalFees: string,
    owedToChallengers: string,
    ...rest: (readonly string[] | string | undefined)[]
  ): string;
  challengerPaid(
    claimId: string | number,
    challenger: string,
    stake: string,
    net: string,
    gross: string,
    fee: string,
  ): string;
  feeClaimed(amount: string, recipient: string): string;
  withdrawal(amount: string, to: string): string;
  withdrawalPending(amount: string, to: string): string;

  // ── mimir-squad ─────────────────────────────────────────────────────────
  marketCreated(
    marketId: string | number,
    question: string,
    captain: string,
    feeBps: string,
    deadline: string,
    category?: string | null,
  ): string;
  deposited(
    marketId: string | number,
    amount: string,
    side: string,
    participant: string,
  ): string;
  withdrawn(
    marketId: string | number,
    participant: string,
    amount: string,
    side: string,
  ): string;
  resolved(
    marketId: string | number,
    result: string,
    poolA: string,
    poolB: string,
  ): string;
  resolvedPayout(ratio: string): string;
  resolvedNoWinningStake(side: string): string;
  claimed(
    marketId: string | number,
    participant: string,
    net: string,
    gross: string,
    fee: string,
  ): string;
  feesClaimedSquad(amount: string, recipient: string): string;

  /**
   * Last-resort one-liner when even the plain-text formatter cannot render.
   * Never returns an empty string.
   */
  minimal(source: string, ledger: string, eventId: string): string;
}

/** Operator pause replies (MarkdownV2). */
export interface PauseMessages {
  paused: string;
  alreadyPaused: string;
  stopped: string;
}

/** Operator resume replies (MarkdownV2). */
export interface ResumeMessages {
  resumed: string;
  alreadyRunning: string;
  stopped: string;
}

/** Every localized string the bot can render. */
export interface Messages {
  helpTitle: string;
  helpIntro: string;
  pauseMessages: PauseMessages;
  resumeMessages: ResumeMessages;
  auditCliHint: string;
  commandDescriptions: Readonly<Record<CommandName, string>>;
  notificationMd: NotificationMarkdownTemplates;
  notificationPlain: NotificationPlainTemplates;
  explorerButtonText: string;
  mimirAppButtonText: string;
}

// ── Notifications: event headlines (English MarkdownV2) ─────────────────────

export const NOTIFICATION_MD: NotificationMarkdownTemplates = {
  // ── mimir-market ────────────────────────────────────────────────────────
  /** @param claimId already-escaped string, e.g. "7" */
  claimCreated: (claimId: string, category: string, creator: string): string =>
    `🆕 *New claim* \\#${claimId}\nCategory: ${category}\nCreator: ${creator}`,

  claimChallenged: (claimId: string, stake: string, challenger: string): string =>
    `⚔️ *Claim \\#${claimId} challenged*\nStake: *${stake}*\nChallenger: ${challenger}`,

  claimResolved: (
    claimId: string,
    winnerSide: string,
    confidence: string,
    summary: string | null,
  ): string =>
    (
      `⚖️ *Claim \\#${claimId} resolved* — winner: *${winnerSide}*\n` +
      `Confidence: ${confidence}\n` +
      (summary ? `_${summary}_` : "")
    ).trimEnd(),

  claimCancelled: (claimId: string): string =>
    `🚫 *Claim \\#${claimId} cancelled* — stakes returned`,

  marketSettled: (
    claimId: string,
    totalPaid: string,
    totalFees: string,
    owedToChallengers: string,
    ...rest: (readonly string[] | string | undefined)[]
  ): string => {
    const lines = rest[0];
    const linesPart = Array.isArray(lines)
      ? `\n${lines.join("\n")}`
      : typeof lines === "string" && lines.length > 0
        ? `\n${lines}`
        : "";
    if (linesPart) {
      return `💰 *Claim \\#${claimId} settled*\nPaid out: *${totalPaid}* · fees ${totalFees}${linesPart}`;
    }
    return `💰 *Claim \\#${claimId} settled*\nPaid out: *${totalPaid}* · fees ${totalFees}\nOwed to challengers: ${owedToChallengers}`;
  },

  challengerPaid: (
    claimId: string,
    challenger: string,
    stake: string,
    net: string,
    gross: string,
    fee: string,
  ): string =>
    `🏆 *Challenger paid* on claim \\#${claimId}\n${challenger} staked ${stake} → net *${net}*\nGross ${gross} · fee ${fee}`,

  feeClaimed: (amount: string, recipient: string): string =>
    `🧾 *Fees claimed* — ${amount} to ${recipient}`,

  withdrawal: (amount: string, to: string): string =>
    `📤 *Withdrawal* — ${amount} to ${to}`,

  withdrawalPending: (amount: string, to: string): string =>
    `⏳ *Withdrawal parked* — ${amount} claimable by ${to}`,

  // ── mimir-squad ─────────────────────────────────────────────────────────
  marketCreated: (
    marketId: string,
    question: string,
    captain: string,
    feeBps: string,
    deadline: string,
    category?: string | null,
  ): string =>
    (
      `🆕 *New squad market* \\#${marketId}\n${question}\nCaptain: ${captain} · fee ${feeBps} bps · deadline ${deadline}` +
      (category ? `\nCategory: ${category}` : "")
    ),

  deposited: (marketId: string, amount: string, side: string, participant: string): string =>
    `➕ *Squad \\#${marketId}* — ${amount} on *${side}*\nParticipant: ${participant}`,

  withdrawn: (marketId: string, participant: string, amount: string, side: string): string =>
    `➖ *Squad \\#${marketId}* — ${participant} pulled ${amount} from ${side}`,

  resolved: (marketId: string, result: string, poolA: string, poolB: string): string =>
    `🏁 *Squad \\#${marketId} resolved* — *${result}*\nPools: A ${poolA} · B ${poolB}`,

  resolvedPayout: (ratio: string): string =>
    `Payout: ${ratio} per 1 USDC staked \\(gross\\)`,

  resolvedNoWinningStake: (side: string): string =>
    `Payout: none — no stake on ${side}`,

  claimed: (
    marketId: string,
    participant: string,
    net: string,
    gross: string,
    fee: string,
  ): string =>
    `💸 *Squad payout* on \\#${marketId}\n${participant} → net *${net}* \\(gross ${gross}, fee ${fee}\\)`,

  feesClaimedSquad: (amount: string, recipient: string): string =>
    `🧾 *Squad fees claimed* — ${amount} to ${recipient}`,

  // ── Fallback ─────────────────────────────────────────────────────────────
  fallbackEvent: (
    source: string,
    contract: string,
    ledger: string,
    reason: string,
    txPart: string,
  ): string =>
    `⚠️ *Event Notification Fallback* \\(${source}\\)\nContract: \`${contract}\` · Ledger: ${ledger}${txPart}\nReason: _${reason}_`,

  // ── Preview mode prefix ──────────────────────────────────────────────────
  previewModePrefix: "🧪 *[PREVIEW MODE]*",

  // ── Channel preview headers ──────────────────────────────────────────────
  channelPreviewMarket: "🧪 *Channel Preview — mimir\\-market*",
  channelPreviewSquad: "🧪 *Channel Preview — mimir\\-squad*",
};

// ── Notifications: event headlines (English plain text) ─────────────────────

export const NOTIFICATION_PLAIN: NotificationPlainTemplates = {
  // ── mimir-market ────────────────────────────────────────────────────────
  claimCreated: (claimId: string | number, category: string, creator: string): string =>
    `New claim #${claimId}\nCategory: ${category}\nCreator: ${creator}`,

  claimChallenged: (
    claimId: string | number,
    stake: string,
    challenger: string,
  ): string =>
    `Claim #${claimId} challenged\nStake: ${stake}\nChallenger: ${challenger}`,

  claimResolved: (
    claimId: string | number,
    winnerSide: string,
    confidence: string,
    summary: string | null,
  ): string =>
    `Claim #${claimId} resolved — winner: ${winnerSide}\nConfidence: ${confidence}` +
    (summary ? `\n${summary}` : ""),

  claimCancelled: (claimId: string | number): string =>
    `Claim #${claimId} cancelled — stakes returned`,

  marketSettled: (
    claimId: string | number,
    totalPaid: string,
    totalFees: string,
    owedToChallengers: string,
    ...rest: (readonly string[] | string | undefined)[]
  ): string => {
    const lines = rest[0];
    const linesPart = Array.isArray(lines)
      ? `\n${lines.join("\n")}`
      : typeof lines === "string" && lines.length > 0
        ? `\n${lines}`
        : "";
    if (linesPart) {
      return `Claim #${claimId} settled\nPaid out: ${totalPaid} · fees ${totalFees}${linesPart}`;
    }
    return `Claim #${claimId} settled\nPaid out: ${totalPaid} · fees ${totalFees}\nOwed to challengers: ${owedToChallengers}`;
  },

  challengerPaid: (
    claimId: string | number,
    challenger: string,
    stake: string,
    net: string,
    gross: string,
    fee: string,
  ): string =>
    `Challenger paid on claim #${claimId}\n${challenger} staked ${stake} → net ${net}\nGross ${gross} · fee ${fee}`,

  feeClaimed: (amount: string, recipient: string): string =>
    `Fees claimed — ${amount} to ${recipient}`,

  withdrawal: (amount: string, to: string): string =>
    `Withdrawal — ${amount} to ${to}`,

  withdrawalPending: (amount: string, to: string): string =>
    `Withdrawal parked — ${amount} claimable by ${to}`,

  // ── mimir-squad ─────────────────────────────────────────────────────────
  marketCreated: (
    marketId: string | number,
    question: string,
    captain: string,
    feeBps: string,
    deadline: string,
    category?: string | null,
  ): string =>
    (
      `New squad market #${marketId}\n${question}\nCaptain: ${captain} · fee ${feeBps} bps · deadline ${deadline}` +
      (category ? `\nCategory: ${category}` : "")
    ),

  deposited: (
    marketId: string | number,
    amount: string,
    side: string,
    participant: string,
  ): string =>
    `Squad #${marketId} — ${amount} on ${side}\nParticipant: ${participant}`,

  withdrawn: (
    marketId: string | number,
    participant: string,
    amount: string,
    side: string,
  ): string =>
    `Squad #${marketId} — ${participant} pulled ${amount} from ${side}`,

  resolved: (
    marketId: string | number,
    result: string,
    poolA: string,
    poolB: string,
  ): string =>
    `Squad #${marketId} resolved — ${result}\nPools: A ${poolA} · B ${poolB}`,

  resolvedPayout: (ratio: string): string => `Payout: ${ratio} per 1 USDC staked (gross)`,

  resolvedNoWinningStake: (side: string): string => `Payout: none — no stake on ${side}`,

  claimed: (
    marketId: string | number,
    participant: string,
    net: string,
    gross: string,
    fee: string,
  ): string =>
    `Squad payout on #${marketId}\n${participant} → net ${net} (gross ${gross}, fee ${fee})`,

  feesClaimedSquad: (amount: string, recipient: string): string =>
    `Squad fees claimed — ${amount} to ${recipient}`,

  minimal: (source: string, ledger: string, eventId: string): string => {
    const idPart = eventId ? ` (${eventId})` : "";
    return `Mimir event (${source}) — ${ledger}${idPart}`;
  },
};

// ── Explorer button (English) ────────────────────────────────────────────────

/** Text shown on the Telegram inline keyboard button for explorer links. */
export const EXPLORER_BUTTON_TEXT = "View on Explorer";

/**
 * Text shown on the Telegram inline keyboard button that opens the Mimir web
 * app (see `MIMIR_APP_URL`). Absent from a keyboard when no URL is configured.
 */
export const MIMIR_APP_BUTTON_TEXT = "Open in Mimir";

// ── Spanish translations ─────────────────────────────────────────────────────
// Same shape and MarkdownV2 rules as the English reference strings above.
// Dynamic values arrive already escaped; static reserved characters are
// escaped here.

const ES_PAUSE_MESSAGES: PauseMessages = {
  paused:
    "*Sondeo en pausa*\nEl escaneo actual puede terminar, pero no se iniciará ningún ciclo nuevo\\. Los cursores no cambiaron\\.",
  alreadyPaused: "*El sondeo ya está en pausa*",
  stopped: "*El sondeo no puede pausarse* — el proceso se está deteniendo\\.",
};

const ES_RESUME_MESSAGES: ResumeMessages = {
  resumed: "*Sondeo reanudado*\nEl siguiente escaneo empieza ahora\\. Los cursores no cambiaron\\.",
  alreadyRunning: "*El sondeo ya está en marcha*",
  stopped: "*El sondeo no puede reanudarse* — el proceso se está deteniendo\\.",
};

const ES_COMMAND_DESCRIPTIONS: Readonly<Record<CommandName, string>> = {
  start: "Qué hace este bot",
  help: "Mostrar ayuda",
  about: "Acerca de este bot",
  status: "Último ledger visto y contratos vigilados",
  audit: "Solo operadores: informe de auditoría (redactado, acotado)",
  contracts: "Ids de contratos y enlaces al explorador",
  health: "Evaluación de salud y preparación operativa",
  preview: "Previsualizar el formato de las notificaciones del canal",
  pause: "Solo operadores: pausar nuevos escaneos",
  resume: "Solo operadores: reanudar el sondeo ahora",
};

const ES_NOTIFICATION_MD: NotificationMarkdownTemplates = {
  // ── mimir-market ────────────────────────────────────────────────────────
  claimCreated: (claimId: string, category: string, creator: string): string =>
    `🆕 *Nueva reclamación* \\#${claimId}\nCategoría: ${category}\nCreador: ${creator}`,

  claimChallenged: (claimId: string, stake: string, challenger: string): string =>
    `⚔️ *Reclamación \\#${claimId} impugnada*\nApuesta: *${stake}*\nImpugnador: ${challenger}`,

  claimResolved: (
    claimId: string,
    winnerSide: string,
    confidence: string,
    summary: string | null,
  ): string =>
    (
      `⚖️ *Reclamación \\#${claimId} resuelta* — ganador: *${winnerSide}*\n` +
      `Confianza: ${confidence}\n` +
      (summary ? `_${summary}_` : "")
    ).trimEnd(),

  claimCancelled: (claimId: string): string =>
    `🚫 *Reclamación \\#${claimId} cancelada* — apuestas devueltas`,

  marketSettled: (
    claimId: string,
    totalPaid: string,
    totalFees: string,
    owedToChallengers: string,
    ...rest: (readonly string[] | string | undefined)[]
  ): string => {
    const lines = rest[0];
    const linesPart = Array.isArray(lines)
      ? `\n${lines.join("\n")}`
      : typeof lines === "string" && lines.length > 0
        ? `\n${lines}`
        : "";
    if (linesPart) {
      return `💰 *Reclamación \\#${claimId} liquidada*\nPagado: *${totalPaid}* · comisiones ${totalFees}${linesPart}`;
    }
    return `💰 *Reclamación \\#${claimId} liquidada*\nPagado: *${totalPaid}* · comisiones ${totalFees}\nAdeudado a impugnadores: ${owedToChallengers}`;
  },

  challengerPaid: (
    claimId: string,
    challenger: string,
    stake: string,
    net: string,
    gross: string,
    fee: string,
  ): string =>
    `🏆 *Impugnador pagado* en la reclamación \\#${claimId}\n${challenger} apostó ${stake} → neto *${net}*\nBruto ${gross} · comisión ${fee}`,

  feeClaimed: (amount: string, recipient: string): string =>
    `🧾 *Comisiones reclamadas* — ${amount} a ${recipient}`,

  withdrawal: (amount: string, to: string): string =>
    `📤 *Retiro* — ${amount} a ${to}`,

  withdrawalPending: (amount: string, to: string): string =>
    `⏳ *Retiro en espera* — ${amount} reclamable por ${to}`,

  // ── mimir-squad ─────────────────────────────────────────────────────────
  marketCreated: (
    marketId: string,
    question: string,
    captain: string,
    feeBps: string,
    deadline: string,
    category?: string | null,
  ): string =>
    (
      `🆕 *Nuevo mercado de escuadrón* \\#${marketId}\n${question}\nCapitán: ${captain} · comisión ${feeBps} bps · plazo ${deadline}` +
      (category ? `\nCategoría: ${category}` : "")
    ),

  deposited: (marketId: string, amount: string, side: string, participant: string): string =>
    `➕ *Escuadrón \\#${marketId}* — ${amount} en *${side}*\nParticipante: ${participant}`,

  withdrawn: (marketId: string, participant: string, amount: string, side: string): string =>
    `➖ *Escuadrón \\#${marketId}* — ${participant} retiró ${amount} de ${side}`,

  resolved: (marketId: string, result: string, poolA: string, poolB: string): string =>
    `🏁 *Escuadrón \\#${marketId} resuelto* — *${result}*\nPozos: A ${poolA} · B ${poolB}`,

  resolvedPayout: (ratio: string): string =>
    `Pago: ${ratio} por cada 1 USDC apostado \\(bruto\\)`,

  resolvedNoWinningStake: (side: string): string =>
    `Pago: ninguno — nadie apostó en ${side}`,

  claimed: (
    marketId: string,
    participant: string,
    net: string,
    gross: string,
    fee: string,
  ): string =>
    `💸 *Pago de escuadrón* en \\#${marketId}\n${participant} → neto *${net}* \\(bruto ${gross}, comisión ${fee}\\)`,

  feesClaimedSquad: (amount: string, recipient: string): string =>
    `🧾 *Comisiones de escuadrón reclamadas* — ${amount} a ${recipient}`,

  // ── Fallback ─────────────────────────────────────────────────────────────
  fallbackEvent: (
    source: string,
    contract: string,
    ledger: string,
    reason: string,
    txPart: string,
  ): string =>
    `⚠️ *Notificación de evento alternativa* \\(${source}\\)\nContrato: \`${contract}\` · Ledger: ${ledger}${txPart}\nMotivo: _${reason}_`,

  previewModePrefix: "🧪 *VISTA PREVIA*",
  channelPreviewMarket: "🧪 *Vista previa del canal — mimir\\-market*",
  channelPreviewSquad: "🧪 *Vista previa del canal — mimir\\-squad*",
};

const ES_NOTIFICATION_PLAIN: NotificationPlainTemplates = {
  // ── mimir-market ────────────────────────────────────────────────────────
  claimCreated: (claimId: string | number, category: string, creator: string): string =>
    `Nueva reclamación #${claimId}\nCategoría: ${category}\nCreador: ${creator}`,

  claimChallenged: (
    claimId: string | number,
    stake: string,
    challenger: string,
  ): string =>
    `Reclamación #${claimId} impugnada\nApuesta: ${stake}\nImpugnador: ${challenger}`,

  claimResolved: (
    claimId: string | number,
    winnerSide: string,
    confidence: string,
    summary: string | null,
  ): string =>
    `Reclamación #${claimId} resuelta — ganador: ${winnerSide}\nConfianza: ${confidence}` +
    (summary ? `\n${summary}` : ""),

  claimCancelled: (claimId: string | number): string =>
    `Reclamación #${claimId} cancelada — apuestas devueltas`,

  marketSettled: (
    claimId: string | number,
    totalPaid: string,
    totalFees: string,
    owedToChallengers: string,
    ...rest: (readonly string[] | string | undefined)[]
  ): string => {
    const lines = rest[0];
    const linesPart = Array.isArray(lines)
      ? `\n${lines.join("\n")}`
      : typeof lines === "string" && lines.length > 0
        ? `\n${lines}`
        : "";
    if (linesPart) {
      return `Reclamación #${claimId} liquidada\nPagado: ${totalPaid} · comisiones ${totalFees}${linesPart}`;
    }
    return `Reclamación #${claimId} liquidada\nPagado: ${totalPaid} · comisiones ${totalFees}\nAdeudado a impugnadores: ${owedToChallengers}`;
  },

  challengerPaid: (
    claimId: string | number,
    challenger: string,
    stake: string,
    net: string,
    gross: string,
    fee: string,
  ): string =>
    `Impugnador pagado en la reclamación #${claimId}\n${challenger} apostó ${stake} → neto ${net}\nBruto ${gross} · comisión ${fee}`,

  feeClaimed: (amount: string, recipient: string): string =>
    `Comisiones reclamadas — ${amount} a ${recipient}`,

  withdrawal: (amount: string, to: string): string =>
    `Retiro — ${amount} a ${to}`,

  withdrawalPending: (amount: string, to: string): string =>
    `Retiro en espera — ${amount} reclamable por ${to}`,

  // ── mimir-squad ─────────────────────────────────────────────────────────
  marketCreated: (
    marketId: string | number,
    question: string,
    captain: string,
    feeBps: string,
    deadline: string,
    category?: string | null,
  ): string =>
    (
      `Nuevo mercado de escuadrón #${marketId}\n${question}\nCapitán: ${captain} · comisión ${feeBps} bps · plazo ${deadline}` +
      (category ? `\nCategoría: ${category}` : "")
    ),

  deposited: (
    marketId: string | number,
    amount: string,
    side: string,
    participant: string,
  ): string =>
    `Escuadrón #${marketId} — ${amount} en ${side}\nParticipante: ${participant}`,

  withdrawn: (
    marketId: string | number,
    participant: string,
    amount: string,
    side: string,
  ): string =>
    `Escuadrón #${marketId} — ${participant} retiró ${amount} de ${side}`,

  resolved: (
    marketId: string | number,
    result: string,
    poolA: string,
    poolB: string,
  ): string =>
    `Escuadrón #${marketId} resuelto — ${result}\nPozos: A ${poolA} · B ${poolB}`,

  resolvedPayout: (ratio: string): string => `Pago: ${ratio} por cada 1 USDC apostado (bruto)`,

  resolvedNoWinningStake: (side: string): string => `Pago: ninguno — nadie apostó en ${side}`,

  claimed: (
    marketId: string | number,
    participant: string,
    net: string,
    gross: string,
    fee: string,
  ): string =>
    `Pago de escuadrón en #${marketId}\n${participant} → neto ${net} (bruto ${gross}, comisión ${fee})`,

  feesClaimedSquad: (amount: string, recipient: string): string =>
    `Comisiones de escuadrón reclamadas — ${amount} a ${recipient}`,

  minimal: (source: string, ledger: string, eventId: string): string => {
    const idPart = eventId ? ` (${eventId})` : "";
    return `Evento de Mimir (${source}) — ${ledger}${idPart}`;
  },
};

// ── Message catalog ──────────────────────────────────────────────────────────

/** English catalog. The named exports above are this object's fields. */
export const EN_MESSAGES: Messages = {
  helpTitle: HELP_TITLE,
  helpIntro: HELP_INTRO,
  pauseMessages: PAUSE_MESSAGES,
  resumeMessages: RESUME_MESSAGES,
  auditCliHint: AUDIT_CLI_HINT,
  commandDescriptions: COMMAND_DESCRIPTIONS,
  notificationMd: NOTIFICATION_MD,
  notificationPlain: NOTIFICATION_PLAIN,
  explorerButtonText: EXPLORER_BUTTON_TEXT,
  mimirAppButtonText: MIMIR_APP_BUTTON_TEXT,
};

/** Spanish catalog. */
export const ES_MESSAGES: Messages = {
  helpTitle: "*Avisador de Mimir*",
  helpIntro:
    "Vigilo los dos contratos Soroban de Mimir en Stellar y publico aquí cada nuevo evento en cadena: reclamaciones abiertas, apuestas de impugnación, resoluciones del oráculo, liquidaciones y pagos.",
  pauseMessages: ES_PAUSE_MESSAGES,
  resumeMessages: ES_RESUME_MESSAGES,
  auditCliHint:
    "Consulta `npm run audit -- --help` para la herramienta de informe independiente.",
  commandDescriptions: ES_COMMAND_DESCRIPTIONS,
  notificationMd: ES_NOTIFICATION_MD,
  notificationPlain: ES_NOTIFICATION_PLAIN,
  explorerButtonText: "Ver en el explorador",
  mimirAppButtonText: "Abrir en Mimir",
};

/** Every locale's catalog. `Record<Locale, ...>` makes a locale mandatory. */
export const MESSAGES: Readonly<Record<Locale, Messages>> = {
  en: EN_MESSAGES,
  es: ES_MESSAGES,
};

/**
 * Catalog for a locale tag, falling back to English when it is unset or not
 * supported. Config validation rejects unsupported values at boot, so the
 * fallback only covers hand-built configs and older callers.
 */
export function messagesFor(locale?: string | null): Messages {
  const normalized = locale === undefined || locale === null ? null : normalizeLocale(locale);
  return MESSAGES[normalized ?? DEFAULT_LOCALE];
}
