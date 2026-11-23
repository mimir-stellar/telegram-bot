// tests/pagination.test.mjs
// Ported from Jest (#593) to node:test, which is what `npm test` runs.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  paginate,
  encodePaginationCallback,
  parsePaginationCallback,
  pageKeyboard,
} from "../dist/notifications/pagination.js";

/** Helper to extract callback data from InlineKeyboard buttons */
function getButtonData(keyboard) {
  return keyboard.inline_keyboard?.flat().map((b) => b.callback_data);
}

describe("paginate", () => {
  it("splits items into correct page sizes", () => {
    const items = [1, 2, 3, 4, 5];
    const pages = paginate(items, 2);
    assert.deepEqual(pages, [[1, 2], [3, 4], [5]]);
  });
  it("throws on non‑positive pageSize", () => {
    assert.throws(() => paginate([1, 2], 0));
  });
});

describe("encodePaginationCallback", () => {
  it("produces a string under 64 bytes", () => {
    const data = encodePaginationCallback("claims", 0);
    assert.ok(Buffer.byteLength(data, "utf8") <= 64);
    assert.match(data, /^pg:v1:claims:0$/);
  });
});

describe("parsePaginationCallback", () => {
  it("parses valid payload", () => {
    const raw = encodePaginationCallback("markets", 2);
    const parsed = parsePaginationCallback(raw);
    assert.deepEqual(parsed, { kind: "markets", page: 2 });
  });
  it("rejects malformed strings", () => {
    assert.equal(parsePaginationCallback("invalid"), null);
    assert.equal(parsePaginationCallback("pg:v2:claims:0"), null); // wrong version
    assert.equal(parsePaginationCallback("pg:v1:claims:-1"), null); // negative page
  });
  it("rejects overly long payloads", () => {
    const long = "pg:" + "v1:" + "x".repeat(100) + ":0";
    assert.ok(Buffer.byteLength(long, "utf8") > 64);
    assert.equal(parsePaginationCallback(long), null);
  });
});

describe("pageKeyboard", () => {
  const kind = "leaderboard";
  it("omits Prev on first page", () => {
    const kb = pageKeyboard(kind, 0, 3);
    const data = getButtonData(kb);
    assert.deepEqual(data, [encodePaginationCallback(kind, 1)]);
  });
  it("omits Next on last page", () => {
    const kb = pageKeyboard(kind, 2, 3);
    const data = getButtonData(kb);
    assert.deepEqual(data, [encodePaginationCallback(kind, 1)]);
  });
  it("shows both on middle page", () => {
    const kb = pageKeyboard(kind, 1, 3);
    const data = getButtonData(kb);
    assert.deepEqual(data, [
      encodePaginationCallback(kind, 0),
      encodePaginationCallback(kind, 2),
    ]);
  });
});
