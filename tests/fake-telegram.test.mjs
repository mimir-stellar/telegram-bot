import nodeTest from "node:test";
// PR #672 merged only this test file (plus docs and config). Neither
// src/dev/fake-telegram.ts nor the `createNotifier({ token, apiRoot, chatId })`
// API in src/notifier.ts it drives ever landed on main; the real notifier is
// src/notifications/notifier.ts with a different signature. The test is
// skipped (not deleted) with the reason shown in the report; drop this wrapper
// and restore the imports below once the source is merged.
const SKIP = "source for #672 was never merged; see #672";
const test = (name, fn) => nodeTest(name, { skip: SKIP }, fn);
import assert from "node:assert";
// import { startFakeTelegram } from "../src/dev/fake-telegram.js";
// import { createNotifier } from "../src/notifier.js";

test("fake Telegram API receives notifications via createNotifier", async (t) => {
  const fake = await startFakeTelegram();
  t.after(() => fake.close());

  const notifier = createNotifier({
    token: "fake-token",
    apiRoot: fake.url,
    chatId: "123456789",
  });

  await notifier.notify("HELLO", "World");

  const messages = fake.getReceivedMessages();
  assert.strictEqual(messages.length, 1);
  assert.strictEqual(messages[0].chat_id, "123456789");
  assert.strictEqual(messages[0].text, "HELLO World");
});
