/**
 * Tests for the address book.
 *
 * Covers loading, validation, sanitization, hot-reload, and error handling.
 */
import assert from "node:assert/strict";
import { unlinkSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import {
  createAddressBook,
  AddressBook,
} from "../dist/stellar/address-book.js";

/** Create a temporary directory for test files. */
function tempDir() {
  const path = join(process.env.TEMP || "/tmp", `address-book-test-${Date.now()}`);
  mkdirSync(path, { recursive: true });
  return path;
}

/** Clean up a temporary directory. */
function cleanupDir(path) {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

/** Write a JSON file. */
function writeJson(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
}

/** Generate a valid G-prefixed account strkey. */
function genAccount() {
  return "GCLJONJVCLJGE6CSMCHCGYA563ADTCK5YGF3KERDMSNS3MNNDAIXHFA5";
}

/** Generate a valid C-prefixed contract strkey. */
function genContract() {
  return "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";
}

test("address book: labelFor returns short address for unknown address", () => {
  const book = createAddressBook();
  const addr = genAccount();
  const result = book.labelFor(addr);
  assert.equal(result, "GABCD…STUV");
});

test("address book: labelFor returns label and short address for known address", () => {
  const book = createAddressBook();
  const addr = genAccount();
  book.entries.set(addr, "Oracle");
  const result = book.labelFor(addr);
  assert.equal(result, "Oracle (GABCD…STUV)");
});

test("address book: load returns entry count for valid file", async () => {
  const dir = tempDir();
  try {
    const file = join(dir, "addresses.json");
    writeJson(file, [
      { address: "GABCDEF1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890", label: "Oracle" },
      { address: "CABCDEF1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890", label: "Treasury" },
    ]);

    const book = createAddressBook();
    const count = await book.load(file);
    assert.equal(count, 2);
  } finally {
    cleanupDir(dir);
  }
});

test("address book: load returns 0 for missing file", async () => {
  const dir = tempDir();
  try {
    const file = join(dir, "nonexistent.json");
    const book = createAddressBook();
    const count = await book.load(file);
    assert.equal(count, 0);
    assert.equal(book.snapshot().errors.length, 1);
    assert.equal(book.snapshot().errors[0].reason, "File does not exist");
  } finally {
    cleanupDir(dir);
  }
});

test("address book: load skips invalid address", async () => {
  const dir = tempDir();
  try {
    const file = join(dir, "addresses.json");
    writeJson(file, [
      { address: "INVALID", label: "Test" },
      { address: "GABCDEF1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890", label: "Oracle" },
    ]);

    const book = createAddressBook();
    const count = await book.load(file);
    assert.equal(count, 1);
    assert.equal(book.snapshot().errors.length, 1);
    assert.ok(book.snapshot().errors[0].reason.includes("Invalid Stellar strkey"));
  } finally {
    cleanupDir(dir);
  }
});

test("address book: load skips invalid label (too short)", async () => {
  const dir = tempDir();
  try {
    const file = join(dir, "addresses.json");
    writeJson(file, [
      { address: "GABCDEF1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890", label: "" },
      { address: "CABCDEF1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890", label: "Team" },
    ]);

    const book = createAddressBook();
    const count = await book.load(file);
    assert.equal(count, 1);
    assert.equal(book.snapshot().errors.length, 1);
    assert.ok(book.snapshot().errors[0].reason.includes("too short"));
  } finally {
    cleanupDir(dir);
  }
});

test("address book: load skips invalid label (too long)", async () => {
  const dir = tempDir();
  try {
    const file = join(dir, "addresses.json");
    writeJson(file, [
      { address: "GABCDEF1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890", label: "A".repeat(65) },
      { address: "CABCDEF1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890", label: "Team" },
    ]);

    const book = createAddressBook();
    const count = await book.load(file);
    assert.equal(count, 1);
    assert.equal(book.snapshot().errors.length, 1);
    assert.ok(book.snapshot().errors[0].reason.includes("too long"));
  } finally {
    cleanupDir(dir);
  }
});

test("address book: load skips invalid label (non-ASCII)", async () => {
  const dir = tempDir();
  try {
    const file = join(dir, "addresses.json");
    writeJson(file, [
      { address: genAccount(), label: "Test\nLabel" },
      { address: genContract(), label: "Team" },
    ]);

    const book = createAddressBook();
    const count = await book.load(file);
    assert.equal(count, 1);
    assert.equal(book.snapshot().errors.length, 1);
    assert.ok(book.snapshot().errors[0].reason.includes("invalid characters"));
  } finally {
    cleanupDir(dir);
  }
});

test("address book: load sanitizes label (trims whitespace)", async () => {
  const dir = tempDir();
  try {
    const file = join(dir, "addresses.json");
    const addr = genAccount();
    writeJson(file, [
      { address: addr, label: "  Oracle  " },
    ]);

    const book = createAddressBook();
    await book.load(file);
    const result = book.labelFor(addr);
    assert.equal(result, "Oracle (GABCD…STUV)");
  } finally {
    cleanupDir(dir);
  }
});

test("address book: load sanitizes label (clamps to max length)", async () => {
  const dir = tempDir();
  try {
    const file = join(dir, "addresses.json");
    const addr = genAccount();
    writeJson(file, [
      { address: addr, label: "A".repeat(70) },
    ]);

    const book = createAddressBook();
    await book.load(file);
    const result = book.labelFor(addr);
    assert.equal(result, `${"A".repeat(64)} (GABCD…STUV)`);
  } finally {
    cleanupDir(dir);
  }
});

test("address book: load keeps previous book on parse error", async () => {
  const dir = tempDir();
  try {
    const file = join(dir, "addresses.json");
    const addr = genAccount();
    writeJson(file, [
      { address: addr, label: "Oracle" },
    ]);

    const book = createAddressBook();
    await book.load(file);
    assert.equal(book.snapshot().entryCount, 1);

    // Corrupt the file
    writeFileSync(file, "invalid json", "utf-8");
    const count = await book.load(file);
    assert.equal(count, 1); // Previous count preserved
    assert.equal(book.snapshot().errors.length, 1);
    assert.ok(book.snapshot().errors[0].reason.includes("Parse error"));
  } finally {
    cleanupDir(dir);
  }
});

test("address book: load reports line context for errors", async () => {
  const dir = tempDir();
  try {
    const file = join(dir, "addresses.json");
    writeJson(file, [
      { address: genAccount(), label: "Oracle" },
      { address: "INVALID", label: "Test" },
      { address: genContract(), label: "Treasury" },
    ]);

    const book = createAddressBook();
    await book.load(file);
    const errors = book.snapshot().errors;
    assert.equal(errors.length, 1);
    assert.equal(errors[0].line, 2);
  } finally {
    cleanupDir(dir);
  }
});

test("address book: load handles non-array root", async () => {
  const dir = tempDir();
  try {
    const file = join(dir, "addresses.json");
    writeJson(file, { not: "an array" });

    const book = createAddressBook();
    const count = await book.load(file);
    assert.equal(count, 0);
    assert.equal(book.snapshot().errors.length, 1);
    assert.equal(book.snapshot().errors[0].reason, "Root must be an array");
  } finally {
    cleanupDir(dir);
  }
});

test("address book: load handles malformed entry", async () => {
  const dir = tempDir();
  try {
    const file = join(dir, "addresses.json");
    writeJson(file, [
      "not an object",
      { address: genAccount(), label: "Oracle" },
    ]);

    const book = createAddressBook();
    const count = await book.load(file);
    assert.equal(count, 1);
    assert.equal(book.snapshot().errors.length, 1);
    assert.equal(book.snapshot().errors[0].reason, "Entry must be an object");
  } finally {
    cleanupDir(dir);
  }
});

test("address book: load handles missing address field", async () => {
  const dir = tempDir();
  try {
    const file = join(dir, "addresses.json");
    writeJson(file, [
      { label: "No address" },
      { address: genAccount(), label: "Oracle" },
    ]);

    const book = createAddressBook();
    const count = await book.load(file);
    assert.equal(count, 1);
    assert.equal(book.snapshot().errors.length, 1);
    assert.equal(book.snapshot().errors[0].reason, "address must be a string");
  } finally {
    cleanupDir(dir);
  }
});

test("address book: load handles missing label field", async () => {
  const dir = tempDir();
  try {
    const file = join(dir, "addresses.json");
    writeJson(file, [
      { address: genAccount() },
      { address: genContract(), label: "Team" },
    ]);

    const book = createAddressBook();
    const count = await book.load(file);
    assert.equal(count, 1);
    assert.equal(book.snapshot().errors.length, 1);
    assert.equal(book.snapshot().errors[0].reason, "label must be a string");
  } finally {
    cleanupDir(dir);
  }
});

test("address book: contract addresses are valid", async () => {
  const dir = tempDir();
  try {
    const file = join(dir, "addresses.json");
    writeJson(file, [
      { address: genContract(), label: "Market" },
    ]);

    const book = createAddressBook();
    const count = await book.load(file);
    assert.equal(count, 1);
  } finally {
    cleanupDir(dir);
  }
});

test("address book: snapshot returns current state", async () => {
  const dir = tempDir();
  try {
    const file = join(dir, "addresses.json");
    writeJson(file, [
      { address: genAccount(), label: "Oracle" },
    ]);

    const book = createAddressBook();
    await book.load(file);
    const snapshot = book.snapshot();
    assert.equal(snapshot.entryCount, 1);
    assert.equal(snapshot.filePath, null);
    assert.equal(snapshot.errors.length, 0);
  } finally {
    cleanupDir(dir);
  }
});

test("address book: snapshot includes file path when watching", async () => {
  const dir = tempDir();
  try {
    const file = join(dir, "addresses.json");
    writeJson(file, [
      { address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", label: "Oracle" },
    ]);

    const book = createAddressBook({ reloadDebounceMs: 100 });
    await book.watch(file);
    await delay(50);
    const snapshot = book.snapshot();
    assert.equal(snapshot.filePath, file);
    await book.stopWatching();
  } finally {
    cleanupDir(dir);
  }
});

test("address book: watch loads file and sets up watcher", async () => {
  const dir = tempDir();
  try {
    const file = join(dir, "addresses.json");
    writeJson(file, [
      { address: genAccount(), label: "Oracle" },
    ]);

    const book = createAddressBook({ reloadDebounceMs: 100 });
    const watchPromise = book.watch(file);

    // Give it a moment to load
    await delay(50);
    assert.equal(book.snapshot().entryCount, 1);
    assert.equal(book.filePath, file);

    // Stop watching
    await book.stopWatching();
  } finally {
    cleanupDir(dir);
  }
});

test("address book: stopWatching clears state", async () => {
  const dir = tempDir();
  try {
    const file = join(dir, "addresses.json");
    writeJson(file, [
      { address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", label: "Oracle" },
    ]);

    const book = createAddressBook({ reloadDebounceMs: 100 });
    await book.watch(file);
    await book.stopWatching();

    assert.equal(book.filePath, null);
    assert.equal(book.watcher, null);
  } finally {
    cleanupDir(dir);
  }
});

test("address book: hot-reload on file change", async () => {
  const dir = tempDir();
  try {
    const file = join(dir, "addresses.json");
    const addr1 = genAccount();
    const addr2 = genContract();
    writeJson(file, [
      { address: addr1, label: "Oracle" },
    ]);

    const book = createAddressBook({ reloadDebounceMs: 100 });
    await book.watch(file);
    assert.equal(book.snapshot().entryCount, 1);

    // Modify the file
    writeJson(file, [
      { address: addr1, label: "Oracle" },
      { address: addr2, label: "Team" },
    ]);

    // Wait for debounce and reload
    await delay(200);
    assert.equal(book.snapshot().entryCount, 2);

    await book.stopWatching();
  } finally {
    cleanupDir(dir);
  }
});

test("address book: hot-reload keeps previous book on parse error", async () => {
  const dir = tempDir();
  try {
    const file = join(dir, "addresses.json");
    const addr = genAccount();
    writeJson(file, [
      { address: addr, label: "Oracle" },
    ]);

    const book = createAddressBook({ reloadDebounceMs: 100 });
    await book.watch(file);
    assert.equal(book.snapshot().entryCount, 1);

    // Corrupt the file
    writeFileSync(file, "invalid json", "utf-8");

    // Wait for debounce and reload
    await delay(200);
    assert.equal(book.snapshot().entryCount, 1); // Previous count preserved
    assert.ok(book.snapshot().errors.length > 0);

    await book.stopWatching();
  } finally {
    cleanupDir(dir);
  }
});

test("address book: validateAccount accepts G-prefixed strkeys", () => {
  const book = createAddressBook();
  const result = book.validateAddress(genAccount());
  assert.equal(result, null);
});

test("address book: validateContract accepts C-prefixed strkeys", () => {
  const book = createAddressBook();
  const result = book.validateAddress(genContract());
  assert.equal(result, null);
});

test("address book: validateAddress rejects invalid strkeys", () => {
  const book = createAddressBook();
  const result = book.validateAddress("INVALID");
  assert.ok(result !== null);
  assert.ok(result.includes("Invalid Stellar strkey"));
});

test("address book: validateLabel accepts valid labels", () => {
  const book = createAddressBook();
  assert.equal(book.validateLabel("Oracle"), null);
  assert.equal(book.validateLabel("Treasury Wallet"), null);
  assert.equal(book.validateLabel("Team-123"), null);
});

test("address book: validateLabel rejects empty labels", () => {
  const book = createAddressBook();
  const result = book.validateLabel("");
  assert.ok(result !== null);
  assert.ok(result.includes("too short"));
});

test("address book: validateLabel rejects labels with control chars", () => {
  const book = createAddressBook();
  const result = book.validateLabel("Test\nLabel");
  assert.ok(result !== null);
  assert.ok(result.includes("invalid characters"));
});

test("address book: sanitizeLabel trims whitespace", () => {
  const book = createAddressBook();
  const result = book.sanitizeLabel("  Oracle  ");
  assert.equal(result, "Oracle");
});

test("address book: sanitizeLabel clamps to max length", () => {
  const book = createAddressBook();
  const result = book.sanitizeLabel("A".repeat(100));
  assert.equal(result.length, 64);
});
