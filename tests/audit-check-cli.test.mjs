import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AUDIT_FORMAT_VERSION, AUDIT_MAX_DETAIL, auditEntry } from "../dist/audit.js";
import { checkAuditFile } from "../dist/audit-check-cli.js";

async function withTempFile(content) {
  const dir = await mkdtemp(path.join(tmpdir(), "audit-check-test-"));
  const file = path.join(dir, "audit.jsonl");
  await writeFile(file, content, "utf8");
  try {
    return { file, result: await checkAuditFile(file) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("checkAuditFile accepts a valid audit file produced by appendAuditFile", async () => {
  const entry1 = auditEntry("boot", { detail: "System started" });
  const entry2 = auditEntry("cycle_failed", { source: "market", detail: "RPC timeout" });
  const entry3 = auditEntry("send_failed", { detail: "Network error" });

  const content = `${JSON.stringify(entry1)}\n${JSON.stringify(entry2)}\n${JSON.stringify(entry3)}`;
  const { result } = await withTempFile(content);

  assert.equal(result.file.endsWith("audit.jsonl"), true);
  assert.equal(result.totalLines, 3);
  assert.equal(result.validEntries, 3);
  assert.equal(result.issues.length, 0);
});

test("checkAuditFile rejects invalid JSON syntax", async () => {
  const content = `{"v":1,"t":1000,"kind":"boot"}\nnot valid json\n{"v":1,"t":2000,"kind":"shutdown"}`;
  const { result } = await withTempFile(content);

  assert.equal(result.validEntries, 2);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].line, 2);
  assert.equal(result.issues[0].kind, "invalid_json");
  assert.equal(result.issues[0].message, "Invalid JSON syntax");
});

test("checkAuditFile rejects non-object entries", async () => {
  const content = `{"v":1,"t":1000,"kind":"boot"}\n["array","not","object"]\n{"v":1,"t":2000,"kind":"shutdown"}`;
  const { result } = await withTempFile(content);

  assert.equal(result.validEntries, 2);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].line, 2);
  assert.equal(result.issues[0].kind, "invalid_json");
  assert.equal(result.issues[0].message, "Not a JSON object");
});

test("checkAuditFile rejects wrong format version", async () => {
  const content = `{"v":999,"t":1000,"kind":"boot"}\n{"v":1,"t":2000,"kind":"shutdown"}`;
  const { result } = await withTempFile(content);

  assert.equal(result.validEntries, 1);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].line, 1);
  assert.equal(result.issues[0].kind, "wrong_version");
  assert.equal(result.issues[0].message, "Expected version 1, got 999");
});

test("checkAuditFile rejects missing format version", async () => {
  const content = `{"t":1000,"kind":"boot"}\n{"v":1,"t":2000,"kind":"shutdown"}`;
  const { result } = await withTempFile(content);

  assert.equal(result.validEntries, 1);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].line, 1);
  assert.equal(result.issues[0].kind, "wrong_version");
  assert.equal(result.issues[0].message, "Expected version 1, got missing");
});

test("checkAuditFile rejects invalid or missing timestamp", async () => {
  const content = `{"v":1,"t":"not a number","kind":"boot"}\n{"v":1,"kind":"shutdown"}\n{"v":1,"t":2000,"kind":"shutdown"}`;
  const { result } = await withTempFile(content);

  assert.equal(result.validEntries, 1);
  assert.equal(result.issues.length, 2);
  assert.equal(result.issues[0].line, 1);
  assert.equal(result.issues[0].kind, "invalid_json");
  assert.equal(result.issues[0].message, "Invalid or missing timestamp (t)");
  assert.equal(result.issues[1].line, 2);
  assert.equal(result.issues[1].kind, "invalid_json");
  assert.equal(result.issues[1].message, "Invalid or missing timestamp (t)");
});

test("checkAuditFile detects out-of-order timestamps", async () => {
  const content = `{"v":1,"t":3000,"kind":"boot"}\n{"v":1,"t":2000,"kind":"shutdown"}\n{"v":1,"t":1000,"kind":"send_failed"}`;
  const { result } = await withTempFile(content);

  assert.equal(result.validEntries, 3);
  assert.equal(result.issues.length, 2);
  assert.equal(result.issues[0].line, 2);
  assert.equal(result.issues[0].kind, "out_of_order_timestamp");
  assert.equal(result.issues[0].message, "Timestamp 2000 is before previous entry 3000");
  assert.equal(result.issues[1].line, 3);
  assert.equal(result.issues[1].kind, "out_of_order_timestamp");
  assert.equal(result.issues[1].message, "Timestamp 1000 is before previous entry 2000");
});

test("checkAuditFile accepts equal timestamps (same millisecond)", async () => {
  const content = `{"v":1,"t":1000,"kind":"boot"}\n{"v":1,"t":1000,"kind":"shutdown"}\n{"v":1,"t":1000,"kind":"send_failed"}`;
  const { result } = await withTempFile(content);

  assert.equal(result.validEntries, 3);
  assert.equal(result.issues.length, 0);
});

test("checkAuditFile rejects unknown audit kinds", async () => {
  const content = `{"v":1,"t":1000,"kind":"boot"}\n{"v":1,"t":2000,"kind":"not_a_real_kind"}\n{"v":1,"t":3000,"kind":"shutdown"}`;
  const { result } = await withTempFile(content);

  assert.equal(result.validEntries, 2);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].line, 2);
  assert.equal(result.issues[0].kind, "unknown_kind");
  assert.equal(result.issues[0].message, "Unknown audit kind: not_a_real_kind");
});

test("checkAuditFile rejects missing audit kind", async () => {
  const content = `{"v":1,"t":1000}\n{"v":1,"t":2000,"kind":"shutdown"}`;
  const { result } = await withTempFile(content);

  assert.equal(result.validEntries, 1);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].line, 1);
  assert.equal(result.issues[0].kind, "unknown_kind");
  assert.equal(result.issues[0].message, "Unknown audit kind: missing");
});

test("checkAuditFile rejects oversized detail field", async () => {
  const longDetail = "x".repeat(AUDIT_MAX_DETAIL + 1);
  const content = `{"v":1,"t":1000,"kind":"boot","detail":"${longDetail}"}\n{"v":1,"t":2000,"kind":"shutdown"}`;
  const { result } = await withTempFile(content);

  assert.equal(result.validEntries, 1);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].line, 1);
  assert.equal(result.issues[0].kind, "oversized_detail");
  assert.equal(result.issues[0].message, `Detail field is ${AUDIT_MAX_DETAIL + 1} characters (max ${AUDIT_MAX_DETAIL})`);
});

test("checkAuditFile accepts detail field at max size", async () => {
  const maxDetail = "x".repeat(AUDIT_MAX_DETAIL);
  const content = `{"v":1,"t":1000,"kind":"boot","detail":"${maxDetail}"}\n{"v":1,"t":2000,"kind":"shutdown"}`;
  const { result } = await withTempFile(content);

  assert.equal(result.validEntries, 2);
  assert.equal(result.issues.length, 0);
});

test("checkAuditFile rejects non-string detail field", async () => {
  const content = `{"v":1,"t":1000,"kind":"boot","detail":123}\n{"v":1,"t":2000,"kind":"shutdown"}`;
  const { result } = await withTempFile(content);

  assert.equal(result.validEntries, 1);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].line, 1);
  assert.equal(result.issues[0].kind, "invalid_json");
  assert.equal(result.issues[0].message, "Detail field is not a string");
});

test("checkAuditFile rejects invalid source field", async () => {
  const content = `{"v":1,"t":1000,"kind":"boot","source":"invalid"}\n{"v":1,"t":2000,"kind":"shutdown"}`;
  const { result } = await withTempFile(content);

  assert.equal(result.validEntries, 1);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].line, 1);
  assert.equal(result.issues[0].kind, "invalid_json");
  assert.equal(result.issues[0].message, 'Invalid source: invalid (must be "market" or "squad")');
});

test("checkAuditFile accepts valid source fields", async () => {
  const content = `{"v":1,"t":1000,"kind":"boot","source":"market"}\n{"v":1,"t":2000,"kind":"shutdown","source":"squad"}`;
  const { result } = await withTempFile(content);

  assert.equal(result.validEntries, 2);
  assert.equal(result.issues.length, 0);
});

test("checkAuditFile handles empty file", async () => {
  const { result } = await withTempFile("");

  assert.equal(result.totalLines, 1);
  assert.equal(result.validEntries, 0);
  assert.equal(result.issues.length, 0);
});

test("checkAuditFile handles file with only blank lines", async () => {
  const content = "\n\n\n";
  const { result } = await withTempFile(content);

  assert.equal(result.totalLines, 4);
  assert.equal(result.validEntries, 0);
  assert.equal(result.issues.length, 0);
});

test("checkAuditFile reports file not found as issue", async () => {
  const result = await checkAuditFile("/nonexistent/path/audit.jsonl");

  assert.equal(result.file, "/nonexistent/path/audit.jsonl");
  assert.equal(result.totalLines, 0);
  assert.equal(result.validEntries, 0);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].line, 0);
  assert.equal(result.issues[0].kind, "invalid_json");
  assert.equal(result.issues[0].message, "File not found or unreadable");
});

test("checkAuditFile detects multiple issues in one file", async () => {
  const longDetail = "x".repeat(AUDIT_MAX_DETAIL + 1);
  const content = `{"v":1,"t":1000,"kind":"boot"}\ninvalid json\n{"v":999,"t":2000,"kind":"unknown_kind","detail":"${longDetail}"}\n{"v":1,"t":1500,"kind":"shutdown"}`;
  const { result } = await withTempFile(content);

  assert.equal(result.validEntries, 2);
  assert.equal(result.issues.length, 2);

  const kinds = result.issues.map((i) => i.kind);
  assert.equal(kinds.includes("invalid_json"), true);
  assert.equal(kinds.includes("wrong_version"), true);
});

test("checkAuditFile never echoes full detail text in output", async () => {
  const secretDetail = ["SECRET-TOKEN", "-12345"].join("");
  const content = `{"v":1,"t":1000,"kind":"boot","detail":"${secretDetail}"}`;
  const { result } = await withTempFile(content);

  assert.equal(result.validEntries, 1);
  assert.equal(result.issues.length, 0);

  // Verify the detail is not in the result object (we only report length for oversized)
  const resultJson = JSON.stringify(result);
  assert.equal(resultJson.includes(secretDetail), false);
});

test("checkAuditFile reports detail length for oversized fields without showing content", async () => {
  const longDetail = "x".repeat(AUDIT_MAX_DETAIL + 1);
  const content = `{"v":1,"t":1000,"kind":"boot","detail":"${longDetail}"}`;
  const { result } = await withTempFile(content);

  assert.equal(result.validEntries, 0);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].kind, "oversized_detail");

  // Verify the long detail is not in the issue message
  assert.equal(result.issues[0].message.includes(longDetail), false);
  assert.equal(result.issues[0].message.includes(AUDIT_MAX_DETAIL.toString()), true);
});
