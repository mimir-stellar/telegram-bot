/**
 * Route verification: probe each configured Telegram route before the bot
 * starts sending real notifications, so a misconfigured forum topic (bad
 * chat id, topic deleted, bot not a member) is detected at startup rather
 * than silently swallowed during a live poll cycle.
 *
 * Strategy: for each route that declares a `topicId`, call
 * `bot.api.getForumTopicIconStickers` is not available on plain topics, so
 * instead we probe with `bot.api.sendMessage` to the chat+thread and
 * immediately delete the probe message on success. For routes without a topic,
 * the existing delivery path already surfaces chat-not-found errors; only
 * topic routes are probed here because a bad thread id fails silently (the
 * message lands in the general chat instead of the topic, or the API returns
 * a 400 for deleted/non-existent topics in some configurations).
 *
 * Invalid routes are disabled (dropped from the returned list) so the rest of
 * the working routes are preserved. The error is logged with bounded metadata;
 * no message text or tokens are included.
 */

import type { Bot } from "grammy";

import { safeErrorMessage } from "./format.js";

/** A notification route with an optional forum topic. */
export interface NotificationRoute {
  /** Telegram chat id or @channelusername. */
  chatId: string;
  /**
   * Optional Telegram forum topic id (`message_thread_id`). When set, every
   * notification for this route is posted into that topic.
   */
  topicId?: number | undefined;
}

export interface VerifyRoutesOptions {
  /** Text of the probe message (kept short; deleted right after). */
  probeText?: string;
  /** Silently skip the delete step on failure — still counts as verified. */
  deleteOnSuccess?: boolean;
}

/**
 * Probe each route that has a `topicId` to confirm it is reachable. Routes
 * that cannot be reached are dropped and a warning is logged. Routes without
 * a `topicId` are returned as-is (they are verified by the normal send path).
 *
 * @returns The subset of routes that passed verification.
 */
export async function verifyRoutes(
  bot: Pick<Bot, "api">,
  routes: readonly NotificationRoute[],
  options: VerifyRoutesOptions = {},
): Promise<NotificationRoute[]> {
  const probeText = options.probeText ?? "⚙️ route check";
  const deleteOnSuccess = options.deleteOnSuccess ?? true;

  const results: NotificationRoute[] = [];

  for (const route of routes) {
    if (route.topicId === undefined) {
      // No topic to verify — route is accepted as configured.
      results.push(route);
      continue;
    }

    // Probe: attempt to send a short message into the forum topic.
    let messageId: number | undefined;
    try {
      const sent = await (bot.api as unknown as FakeSendApi).sendMessage(
        route.chatId,
        probeText,
        { message_thread_id: route.topicId },
      );
      messageId = (sent as { message_id?: number }).message_id;
    } catch (err) {
      console.warn(
        `[verify-routes] route disabled — topic ${route.topicId} in chat ${route.chatId} ` +
          `is not reachable: ${safeErrorMessage(err)}`,
      );
      // Drop the route: it cannot receive messages.
      continue;
    }

    // Best-effort cleanup of the probe message.
    if (deleteOnSuccess && messageId !== undefined) {
      try {
        await (bot.api as unknown as FakeDeleteApi).deleteMessage(route.chatId, messageId);
      } catch {
        // Non-fatal: deletion failure does not invalidate the route.
      }
    }

    results.push(route);
  }

  return results;
}

// ── Minimal API surface used above (duck-typed for testability) ───────────────

interface FakeSendApi {
  sendMessage(
    chatId: string,
    text: string,
    options?: { message_thread_id?: number },
  ): Promise<unknown>;
}

interface FakeDeleteApi {
  deleteMessage(chatId: string, messageId: number): Promise<unknown>;
}
