/**
 * Integration fake for Telegram Bot API send failures.
 *
 * The live notifier must stay up through revoked tokens, kicked chats, 429s,
 * and flaky networks. This module is the offline stand-in for those modes:
 * scriptable outcomes, call recording, and bot-/send-shaped adapters that
 * plug into {@link createNotifier} and {@link createPoller} without a real
 * BOT_TOKEN or network.
 *
 * Errors never embed bot tokens. Descriptions are bounded so hostile API
 * payloads cannot flood logs in tests the way they must not in production.
 */

/** Cap copied into fake error descriptions (mirrors production log hygiene). */
export const TELEGRAM_FAKE_DESCRIPTION_MAX = 240;

export type TelegramFakeOk = {
  type: "ok";
  messageId?: number;
};

export type TelegramFakeApiError = {
  type: "api_error";
  /** Telegram `error_code` (e.g. 429, 403, 401, 400). */
  errorCode: number;
  description: string;
  parameters?: { retry_after?: number };
};

export type TelegramFakeNetworkError = {
  type: "network";
  message?: string;
};

export type TelegramFakeThrow = {
  type: "throw";
  error: Error;
};

export type TelegramFakeOutcome =
  | TelegramFakeOk
  | TelegramFakeApiError
  | TelegramFakeNetworkError
  | TelegramFakeThrow;

export interface TelegramFakeCall {
  at: number;
  method: "sendMessage";
  chatId: string;
  text: string;
  parseMode: string | undefined;
  /** Outcome kind that was applied for this call. */
  outcome: TelegramFakeOutcome["type"];
}

export interface TelegramFakeOptions {
  /** Default chat id used by {@link TelegramFake.asSend}. */
  chatId?: string;
  /** When the script is exhausted, keep returning this (default: ok). */
  defaultOutcome?: TelegramFakeOutcome;
}

/** Grammy-shaped error duck type — enough for classifiers and `instanceof`-free checks. */
export class FakeGrammyError extends Error {
  readonly error_code: number;
  readonly description: string;
  readonly parameters: { retry_after?: number };
  readonly method: string;
  /** Payload never includes a bot token. */
  readonly payload: Record<string, unknown>;

  constructor(
    method: string,
    errorCode: number,
    description: string,
    payload: Record<string, unknown> = {},
    parameters: { retry_after?: number } = {},
  ) {
    const safe = boundDescription(description);
    super(`Call to '${method}' failed! (${errorCode}: ${safe})`);
    this.name = "GrammyError";
    this.error_code = errorCode;
    this.description = safe;
    this.parameters = parameters;
    this.method = method;
    this.payload = payload;
  }
}

export class FakeHttpError extends Error {
  constructor(message = "Network request for 'sendMessage' failed") {
    super(message);
    this.name = "HttpError";
  }
}

function boundDescription(raw: string): string {
  const oneLine = raw.replace(/[\r\n\t]+/g, " ").trim();
  if (oneLine.length <= TELEGRAM_FAKE_DESCRIPTION_MAX) return oneLine;
  return `${oneLine.slice(0, TELEGRAM_FAKE_DESCRIPTION_MAX - 1)}…`;
}

/** Strip BotFather-shaped tokens if a test accidentally puts one in a description. */
export function redactTelegramSecrets(text: string): string {
  return text.replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[redacted-bot-token]");
}

export function outcomeRateLimit(retryAfter = 3): TelegramFakeApiError {
  return {
    type: "api_error",
    errorCode: 429,
    description: "Too Many Requests: retry after",
    parameters: { retry_after: retryAfter },
  };
}

export function outcomeForbidden(
  description = "Forbidden: bot was kicked from the group chat",
): TelegramFakeApiError {
  return { type: "api_error", errorCode: 403, description };
}

export function outcomeUnauthorized(
  description = "Unauthorized",
): TelegramFakeApiError {
  return { type: "api_error", errorCode: 401, description };
}

export function outcomeBadRequest(
  description = "Bad Request: chat not found",
): TelegramFakeApiError {
  return { type: "api_error", errorCode: 400, description };
}

export function outcomeNetwork(message?: string): TelegramFakeNetworkError {
  return { type: "network", message };
}

export function outcomeOk(messageId = 1): TelegramFakeOk {
  return { type: "ok", messageId };
}

/**
 * Scriptable Telegram Bot API fake.
 *
 * Outcomes are consumed in order; once exhausted, {@link TelegramFakeOptions.defaultOutcome}
 * applies (defaults to success). Use this to drive createNotifier / poller send
 * paths through rate limits, auth failures, and transient network errors offline.
 */
export class TelegramFake {
  readonly calls: TelegramFakeCall[] = [];
  private script: TelegramFakeOutcome[] = [];
  private defaultOutcome: TelegramFakeOutcome;
  private readonly defaultChatId: string;
  private nextMessageId = 1;

  constructor(options: TelegramFakeOptions = {}) {
    this.defaultChatId = options.chatId ?? "-1001234567890";
    this.defaultOutcome = options.defaultOutcome ?? outcomeOk();
  }

  /** Replace the outcome script (consumed FIFO on each sendMessage). */
  scriptOutcomes(...outcomes: TelegramFakeOutcome[]): this {
    this.script = [...outcomes];
    return this;
  }

  setDefault(outcome: TelegramFakeOutcome): this {
    this.defaultOutcome = outcome;
    return this;
  }

  reset(): this {
    this.calls.length = 0;
    this.script = [];
    this.defaultOutcome = outcomeOk();
    this.nextMessageId = 1;
    return this;
  }

  /** Duck-typed grammy `Bot` surface for {@link createNotifier}. */
  asBot(): {
    api: {
      sendMessage: (
        chatId: string | number,
        text: string,
        other?: Record<string, unknown>,
      ) => Promise<{ message_id: number; text: string; chat: { id: string } }>;
    };
  } {
    return {
      api: {
        sendMessage: (chatId, text, other) => this.sendMessage(chatId, text, other),
      },
    };
  }

  /** Direct `PollerDeps.send` adapter bound to the fake's default chat id. */
  asSend(): (text: string) => Promise<void> {
    return async (text: string) => {
      await this.sendMessage(this.defaultChatId, text, {
        parse_mode: "MarkdownV2",
        link_preview_options: { is_disabled: true },
      });
    };
  }

  private takeOutcome(): TelegramFakeOutcome {
    if (this.script.length > 0) {
      return this.script.shift() as TelegramFakeOutcome;
    }
    return this.defaultOutcome;
  }

  private async sendMessage(
    chatId: string | number,
    text: string,
    other?: Record<string, unknown>,
  ): Promise<{ message_id: number; text: string; chat: { id: string } }> {
    const outcome = this.takeOutcome();
    const chat = String(chatId);
    const parseMode =
      typeof other?.["parse_mode"] === "string" ? (other["parse_mode"] as string) : undefined;

    this.calls.push({
      at: Date.now(),
      method: "sendMessage",
      chatId: chat,
      text,
      parseMode,
      outcome: outcome.type,
    });

    switch (outcome.type) {
      case "ok": {
        const messageId = outcome.messageId ?? this.nextMessageId++;
        return { message_id: messageId, text, chat: { id: chat } };
      }
      case "api_error": {
        throw new FakeGrammyError(
          "sendMessage",
          outcome.errorCode,
          redactTelegramSecrets(outcome.description),
          { chat_id: chat, text_length: text.length },
          outcome.parameters ?? {},
        );
      }
      case "network": {
        throw new FakeHttpError(
          redactTelegramSecrets(outcome.message ?? "Network request for 'sendMessage' failed"),
        );
      }
      case "throw": {
        throw outcome.error;
      }
      default: {
        const _exhaustive: never = outcome;
        throw new Error(`Unhandled TelegramFake outcome: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }
}

/**
 * Apply the poller's lossy Telegram send policy to a message batch (no RPC).
 *
 * One failed send increments `failed` and continues; the batch never aborts.
 * Used by integration tests to prove cursor-advance semantics stay safe when
 * Telegram is down — notifications are lossy; the chain remains the record.
 */
export async function deliverWithLossyTelegramPolicy(
  send: (text: string) => Promise<void>,
  messages: readonly string[],
  options: { maxNotificationsPerCycle?: number } = {},
): Promise<{ sent: number; failed: number; skipped: number }> {
  const cap = options.maxNotificationsPerCycle ?? Number.POSITIVE_INFINITY;
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  let sentThisCycle = 0;

  for (const text of messages) {
    if (sentThisCycle >= cap) {
      skipped += 1;
      continue;
    }
    try {
      await send(text);
      sent += 1;
      sentThisCycle += 1;
    } catch {
      failed += 1;
    }
  }

  return { sent, failed, skipped };
}
