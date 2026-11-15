/**
 * Local loopback-only Fake Telegram Bot API server for hermetic route and
 * delivery verification tests.
 *
 * Never contacts the network beyond `127.0.0.1`, holds no credentials, and
 * scrubs bot tokens out of recorded request paths.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeTelegramChatConfig {
  type?: "private" | "group" | "supergroup" | "channel" | undefined;
  title?: string | undefined;
  isForum?: boolean | undefined;
  /** Forum topic thread IDs (`message_thread_id`) that exist and are open. */
  openTopics?: readonly number[] | undefined;
  /** Forum topic thread IDs that exist but are closed (`TOPIC_CLOSED`). */
  closedTopics?: readonly number[] | undefined;
  /** Simulate `400 Bad Request: chat not found`. */
  notFound?: boolean | undefined;
  /** Simulate `403 Forbidden: bot is not a member of the chat`. */
  forbidden?: boolean | undefined;
}

export interface FakeTelegramOptions {
  port?: number | undefined;
  chats?: Readonly<Record<string, FakeTelegramChatConfig>> | undefined;
}

export interface FakeTelegramCall {
  method: string;
  payload: Record<string, unknown>;
}

export interface FakeReceivedMessage {
  message_id: number;
  chat_id: string | number;
  message_thread_id?: number | undefined;
  text: string;
  parse_mode?: string | undefined;
  disable_notification?: boolean | undefined;
}

export interface FakeTelegramServer {
  readonly url: string;
  readonly port: number;
  getCalls(): FakeTelegramCall[];
  getReceivedMessages(): FakeReceivedMessage[];
  close(): Promise<void>;
}

function parseBody(raw: string, contentType: string | undefined): Record<string, unknown> {
  const trimmed = raw.trim();
  if (trimmed === "") return {};
  if (contentType?.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(trimmed);
    const out: Record<string, unknown> = {};
    for (const [k, v] of params.entries()) {
      out[k] = v;
    }
    return out;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function sendJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function parseOptionalThreadId(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isInteger(n) ? n : NaN;
}

export async function startFakeTelegram(
  options: FakeTelegramOptions = {},
): Promise<FakeTelegramServer> {
  const chats = options.chats ?? {};
  const calls: FakeTelegramCall[] = [];
  const receivedMessages: FakeReceivedMessage[] = [];
  let nextMessageId = 1;

  const validateChatAndTopic = (
    chatKey: string,
    threadId: number | undefined,
  ): { status: number; description: string } | null => {
    const chat = chats[chatKey];
    if (chat?.notFound) {
      return { status: 400, description: "Bad Request: chat not found" };
    }
    if (chat?.forbidden) {
      return {
        status: 403,
        description: "Forbidden: bot is not a member of the supergroup chat",
      };
    }
    if (threadId !== undefined) {
      if (!Number.isInteger(threadId) || threadId < 1) {
        return { status: 400, description: "Bad Request: invalid message_thread_id" };
      }
      if (!chat || chat.isForum !== true) {
        return { status: 400, description: "Bad Request: message thread not found" };
      }
      if (chat.closedTopics?.includes(threadId)) {
        return { status: 400, description: "Bad Request: TOPIC_CLOSED" };
      }
      if (chat.openTopics !== undefined && !chat.openTopics.includes(threadId)) {
        return { status: 400, description: "Bad Request: message thread not found" };
      }
    }
    return null;
  };

  const server = http.createServer((req, res) => {
    const urlPath = req.url ?? "/";
    const match = /^\/bot[^/]+\/([A-Za-z0-9_]+)(?:\?.*)?$/.exec(urlPath);
    if (!match) {
      sendJson(res, 404, { ok: false, error_code: 404, description: "Not Found" });
      return;
    }
    const method = match[1]!;

    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const payload = parseBody(rawBody, req.headers["content-type"]);
      calls.push({ method, payload });

      if (method === "getMe") {
        sendJson(res, 200, {
          ok: true,
          result: {
            id: 900001,
            is_bot: true,
            first_name: "Mimir Fake Bot",
            username: "mimir_fake_bot",
          },
        });
        return;
      }

      if (method === "setMyCommands") {
        sendJson(res, 200, { ok: true, result: true });
        return;
      }

      const rawChatId = payload.chat_id;
      const chatKey = rawChatId !== undefined ? String(rawChatId) : "";

      if (method === "getChat") {
        const problem = validateChatAndTopic(chatKey, undefined);
        if (problem) {
          sendJson(res, problem.status, {
            ok: false,
            error_code: problem.status,
            description: problem.description,
          });
          return;
        }
        const chat = chats[chatKey];
        const numericId = /^-?\d+$/.test(chatKey) ? Number(chatKey) : -100999999;
        sendJson(res, 200, {
          ok: true,
          result: {
            id: numericId,
            type: chat?.type ?? (chat?.isForum ? "supergroup" : "supergroup"),
            title: chat?.title ?? `Chat ${chatKey}`,
            ...(chat?.isForum ? { is_forum: true } : {}),
            ...(chatKey.startsWith("@") ? { username: chatKey.slice(1) } : {}),
          },
        });
        return;
      }

      if (method === "sendChatAction") {
        const threadId = parseOptionalThreadId(payload.message_thread_id);
        const problem = validateChatAndTopic(chatKey, threadId);
        if (problem) {
          sendJson(res, problem.status, {
            ok: false,
            error_code: problem.status,
            description: problem.description,
          });
          return;
        }
        sendJson(res, 200, { ok: true, result: true });
        return;
      }

      if (method === "sendMessage") {
        const threadId = parseOptionalThreadId(payload.message_thread_id);
        const problem = validateChatAndTopic(chatKey, threadId);
        if (problem) {
          sendJson(res, problem.status, {
            ok: false,
            error_code: problem.status,
            description: problem.description,
          });
          return;
        }
        const msgId = nextMessageId++;
        const record: FakeReceivedMessage = {
          message_id: msgId,
          chat_id: typeof rawChatId === "number" || typeof rawChatId === "string" ? rawChatId : chatKey,
          ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
          text: String(payload.text ?? ""),
          ...(typeof payload.parse_mode === "string" ? { parse_mode: payload.parse_mode } : {}),
          ...(typeof payload.disable_notification === "boolean"
            ? { disable_notification: payload.disable_notification }
            : {}),
        };
        receivedMessages.push(record);
        const numericId = /^-?\d+$/.test(chatKey) ? Number(chatKey) : -100999999;
        sendJson(res, 200, {
          ok: true,
          result: {
            message_id: msgId,
            date: Math.floor(Date.now() / 1000),
            chat: {
              id: numericId,
              type: chats[chatKey]?.type ?? "supergroup",
              ...(chats[chatKey]?.isForum ? { is_forum: true } : {}),
            },
            ...(threadId !== undefined
              ? { message_thread_id: threadId, is_topic_message: true }
              : {}),
            text: record.text,
          },
        });
        return;
      }

      sendJson(res, 400, {
        ok: false,
        error_code: 400,
        description: `Bad Request: unsupported fake method ${method}`,
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    port: addr.port,
    getCalls: () => [...calls],
    getReceivedMessages: () => [...receivedMessages],
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
