import assert from "node:assert/strict";
import test from "node:test";

import { createNotifier } from "../dist/bot.js";
import {
  FakeGrammyError,
  FakeHttpError,
  TelegramFake,
  TELEGRAM_FAKE_DESCRIPTION_MAX,
  deliverWithLossyTelegramPolicy,
  outcomeBadRequest,
  outcomeForbidden,
  outcomeNetwork,
  outcomeOk,
  outcomeRateLimit,
  outcomeUnauthorized,
  redactTelegramSecrets,
} from "../dist/testing/telegramFake.js";

const CHAT = "-1001234567890";
const LEAKY_TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";

test("TelegramFake records successful sends without requiring credentials", async () => {
  const fake = new TelegramFake({ chatId: CHAT });
  const notify = createNotifier(fake.asBot(), { chatId: CHAT });

  await notify("hello *world*");

  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].chatId, CHAT);
  assert.equal(fake.calls[0].text, "hello *world*");
  assert.equal(fake.calls[0].parseMode, "MarkdownV2");
  assert.equal(fake.calls[0].outcome, "ok");
  assert.equal(JSON.stringify(fake.calls).includes(LEAKY_TOKEN), false);
});

test("scripted API failures reject with Grammy-shaped errors (403/401/400/429)", async () => {
  const fake = new TelegramFake({ chatId: CHAT }).scriptOutcomes(
    outcomeForbidden(),
    outcomeUnauthorized(),
    outcomeBadRequest(),
    outcomeRateLimit(7),
  );
  const notify = createNotifier(fake.asBot(), { chatId: CHAT });

  await assert.rejects(() => notify("a"), (err) => {
    assert.ok(err instanceof FakeGrammyError);
    assert.equal(err.error_code, 403);
    assert.match(err.description, /kicked/i);
    assert.equal("botToken" in err.payload, false);
    assert.equal(JSON.stringify(err).includes(LEAKY_TOKEN), false);
    return true;
  });

  await assert.rejects(() => notify("b"), (err) => {
    assert.ok(err instanceof FakeGrammyError);
    assert.equal(err.error_code, 401);
    return true;
  });

  await assert.rejects(() => notify("c"), (err) => {
    assert.ok(err instanceof FakeGrammyError);
    assert.equal(err.error_code, 400);
    return true;
  });

  await assert.rejects(() => notify("d"), (err) => {
    assert.ok(err instanceof FakeGrammyError);
    assert.equal(err.error_code, 429);
    assert.equal(err.parameters.retry_after, 7);
    return true;
  });

  assert.deepEqual(
    fake.calls.map((c) => c.outcome),
    ["api_error", "api_error", "api_error", "api_error"],
  );
});

test("network failures surface as HttpError and never embed bot tokens", async () => {
  const fake = new TelegramFake({ chatId: CHAT }).scriptOutcomes(
    outcomeNetwork(`upstream reset while using ${LEAKY_TOKEN}`),
  );
  const notify = createNotifier(fake.asBot(), { chatId: CHAT });

  await assert.rejects(() => notify("ping"), (err) => {
    assert.ok(err instanceof FakeHttpError);
    assert.equal(err.message.includes(LEAKY_TOKEN), false);
    assert.match(err.message, /\[redacted-bot-token\]/);
    return true;
  });
});

test("hostile unbounded descriptions are capped before throw", async () => {
  const hostile = `x${LEAKY_TOKEN}y`.repeat(200);
  const fake = new TelegramFake({ chatId: CHAT }).scriptOutcomes(
    outcomeForbidden(hostile),
  );
  const notify = createNotifier(fake.asBot(), { chatId: CHAT });

  await assert.rejects(() => notify("z"), (err) => {
    assert.ok(err instanceof FakeGrammyError);
    assert.ok(err.description.length <= TELEGRAM_FAKE_DESCRIPTION_MAX);
    assert.equal(err.description.includes(LEAKY_TOKEN), false);
    return true;
  });
});

test("lossy deliver policy continues after Telegram failures (cursor-safe)", async () => {
  const fake = new TelegramFake({ chatId: CHAT }).scriptOutcomes(
    outcomeOk(10),
    outcomeRateLimit(1),
    outcomeForbidden(),
    outcomeOk(11),
    outcomeNetwork(),
  );

  const result = await deliverWithLossyTelegramPolicy(fake.asSend(), [
    "msg-1",
    "msg-2",
    "msg-3",
    "msg-4",
    "msg-5",
    "msg-6",
  ], { maxNotificationsPerCycle: 5 });

  // 5 attempts under the cap: ok, fail, fail, ok, fail → then 1 skipped
  assert.deepEqual(result, { sent: 2, failed: 3, skipped: 1 });
  assert.equal(fake.calls.length, 5);
  assert.deepEqual(
    fake.calls.map((c) => c.outcome),
    ["ok", "api_error", "api_error", "ok", "network"],
  );
});

test("default outcome after script exhaustion stays successful", async () => {
  const fake = new TelegramFake({ chatId: CHAT }).scriptOutcomes(outcomeForbidden());
  const send = fake.asSend();

  await assert.rejects(() => send("first"));
  await send("second");
  await send("third");

  assert.equal(fake.calls.length, 3);
  assert.equal(fake.calls[1].outcome, "ok");
  assert.equal(fake.calls[2].outcome, "ok");
});

test("redactTelegramSecrets masks BotFather tokens in free text", () => {
  assert.equal(
    redactTelegramSecrets(`token=${LEAKY_TOKEN} ok`),
    "token=[redacted-bot-token] ok",
  );
  assert.equal(redactTelegramSecrets("no secrets here"), "no secrets here");
});

test("createNotifier preserves fake failures for the poller send path", async () => {
  const fake = new TelegramFake({ chatId: CHAT }).setDefault(outcomeUnauthorized());
  const notify = createNotifier(fake.asBot(), { chatId: CHAT });
  await assert.rejects(() => notify("must fail"), FakeGrammyError);
});
