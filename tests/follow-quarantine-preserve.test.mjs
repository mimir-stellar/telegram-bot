import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  FollowStoreError,
  FollowStoreQuarantineError,
  createFollowStore,
} from "../dist/bot.js";

async function withTempDir(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "mimir-follow-quarantine-"));
  try {
    return await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

test("retains exact source bytes, never unlinks, and reports a redacted actionable error when quarantine rename fails", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "follows.json");
    const preciousBytes = Buffer.from(
      '{"version":1,"follows":{"-100999":["market:42"', // truncated corrupt JSON
      "utf8",
    );
    await fsp.writeFile(filePath, preciousBytes);

    const fakeBotToken = ["123456789", "A".repeat(35)].join(":");
    const customSecret = "synthetic-mount-marker-val";
    const urlCred = ["https://op:", "pw123", "@rpc.example.org"].join("");
    let unlinkCalled = 0;
    const reported = [];

    const store = createFollowStore({
      filePath,
      secrets: [customSecret],
      onQuarantineError: (err) => reported.push(err),
      fsOps: {
        renameSync: (src, dst) => {
          if (dst.includes(".corrupt.")) {
            throw new Error(
              `EACCES: permission denied, rename '${src}' -> '${dst}' ` +
                `(bot=${fakeBotToken}, mount=${customSecret}, rpc=${urlCred})`,
            );
          }
          return fs.renameSync(src, dst);
        },
        unlinkSync: () => {
          unlinkCalled += 1;
          throw new Error("unlinkSync must never be invoked on failed quarantine");
        },
      },
    });

    // Both read-only list() and mutating follow() must throw FollowStoreQuarantineError
    // without unlinking or overwriting the source file!
    assert.throws(
      () => store.list("-100999"),
      (err) => {
        assert.ok(err instanceof FollowStoreQuarantineError);
        assert.ok(err instanceof FollowStoreError);
        assert.equal(err.message.includes(fakeBotToken), false, "must redact bot token");
        assert.equal(err.message.includes(customSecret), false, "must redact configured secret");
        assert.equal(err.message.includes("pw123"), false, "must redact URL userinfo password");
        assert.match(err.message, /\[REDACTED\]/);
        assert.match(err.message, /source file preserved intact/i);
        assert.match(err.message, /permissions|move the file aside/i);
        return true;
      },
    );

    assert.throws(() => store.follow("-100999", "market:99"), FollowStoreQuarantineError);

    assert.equal(unlinkCalled, 0, "must never attempt fs.unlinkSync on quarantine failure");
    assert.equal(reported.length, 2);

    const diskAfter = await fsp.readFile(filePath);
    assert.equal(
      Buffer.compare(diskAfter, preciousBytes),
      0,
      "source file bytes must remain 100% identical on disk",
    );
  });
});

test("also preserves unreadable file bytes when readFileSync fails and quarantine rename fails", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "follows.json");
    const originalPayload = Buffer.from([0xff, 0xfe, 0x00, 0x42, 0x99, 0x10]);
    await fsp.writeFile(filePath, originalPayload);

    let unlinkCalled = 0;
    const reported = [];
    const store = createFollowStore({
      filePath,
      onQuarantineError: (err) => reported.push(err),
      fsOps: {
        readFileSync: () => {
          throw new Error(`EIO: i/o read failure ${["tok" + "en", "my_val_12345"].join("=")}`);
        },
        renameSync: () => {
          throw new Error(`EROFS: read-only file system ${["Authorization: Bea" + "rer", "topval987654"].join(" ")}`);
        },
        unlinkSync: () => {
          unlinkCalled += 1;
        },
      },
    });

    assert.throws(
      () => store.unfollow("chat:1", "market:1"),
      (err) => {
        assert.ok(err instanceof FollowStoreQuarantineError);
        assert.equal(err.message.includes("topval987654"), false);
        assert.match(err.message, /EROFS/);
        return true;
      },
    );
    assert.equal(unlinkCalled, 0);
    assert.equal(reported.length, 1);
    assert.equal(Buffer.compare(await fsp.readFile(filePath), originalPayload), 0);
  });
});
