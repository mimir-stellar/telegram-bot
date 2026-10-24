import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  checkEnvExample,
  loadKeyMetadata,
  parseEnvExample,
  runCheck,
} from "../scripts/check-env-example.mjs";

const execFileP = promisify(execFile);
const SCRIPT_PATH = fileURLToPath(
  new URL("../scripts/check-env-example.mjs", import.meta.url),
);

async function withTempFile(contents, fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mimir-env-example-test-"));
  const filePath = path.join(dir, ".env.example");
  try {
    await writeFile(filePath, contents, "utf8");
    await fn(filePath);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

async function runCli(args = []) {
  try {
    const { stdout, stderr } = await execFileP(
      process.execPath,
      [SCRIPT_PATH, ...args],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        timeout: 30_000,
      },
    );
    return { code: 0, stdout, stderr };
  } catch (err) {
    return {
      code: err.code ?? 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  }
}

test(".env.example matches exported key metadata in dist/config.js", async () => {
  const result = await runCheck();
  assert.equal(result.ok, true, result.problems.join("\n"));
  assert.deepEqual(result.missingFromExample, []);
  assert.deepEqual(result.extraInExample, []);
  assert.deepEqual(result.nonEmptySecrets, []);
});

test("scripts/check-env-example.mjs CLI exits 0 on the repository .env.example", async () => {
  const { code, stdout, stderr } = await runCli();
  assert.equal(code, 0, stderr);
  assert.match(stdout, /\.env\.example is in sync/);
});

test("parseEnvExample extracts commented and uncommented keys and skips prose comments", () => {
  const sample = [
    "# =============================================================================",
    "# MIMIR_PROFILE=mock selects the local mock profile for anything below",
    "# MIMIR_PROFILE=mock",
    "BOT_TOKEN=",
    "POLL_INTERVAL_MS=30000",
    "# HEALTH_HOST=127.0.0.1",
    "# ALLOWED_CHAT_IDS=",
  ].join("\n");

  const parsed = parseEnvExample(sample);
  assert.deepEqual(
    parsed.map((e) => ({ key: e.key, value: e.value, commented: e.commented })),
    [
      { key: "MIMIR_PROFILE", value: "mock", commented: true },
      { key: "BOT_TOKEN", value: "", commented: false },
      { key: "POLL_INTERVAL_MS", value: "30000", commented: false },
      { key: "HEALTH_HOST", value: "127.0.0.1", commented: true },
      { key: "ALLOWED_CHAT_IDS", value: "", commented: true },
    ],
  );
});

test("checkEnvExample reports keys missing from .env.example", () => {
  const metadata = [
    { key: "BOT_TOKEN", secret: true },
    { key: "HEALTH_HOST", secret: false },
    { key: "POLL_INTERVAL_MS", secret: false },
  ];
  const sample = ["BOT_TOKEN=", "# HEALTH_HOST=127.0.0.1"].join("\n");

  const result = checkEnvExample(sample, metadata);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missingFromExample, ["POLL_INTERVAL_MS"]);
  assert.match(result.problems.join("\n"), /missing from \.env\.example: POLL_INTERVAL_MS/);
});

test("checkEnvExample reports keys in .env.example that the code never reads", () => {
  const metadata = [
    { key: "BOT_TOKEN", secret: true },
    { key: "HEALTH_HOST", secret: false },
  ];
  const sample = [
    "BOT_TOKEN=",
    "# HEALTH_HOST=127.0.0.1",
    "# UNUSED_LEGACY_KEY=true",
  ].join("\n");

  const result = checkEnvExample(sample, metadata);
  assert.equal(result.ok, false);
  assert.deepEqual(result.extraInExample, ["UNUSED_LEGACY_KEY"]);
  assert.match(
    result.problems.join("\n"),
    /present in \.env\.example but never read by config: UNUSED_LEGACY_KEY/,
  );
});

test("checkEnvExample rejects secret keys with non-empty values and CLI exits non-zero", async () => {
  const metadata = await loadKeyMetadata();
  const lines = metadata.map((entry) => {
    if (entry.key === "BOT_TOKEN") {
      return "BOT_TOKEN=placeholder-not-allowed";
    }
    return entry.secret ? `# ${entry.key}=` : `# ${entry.key}=example`;
  });

  const sample = lines.join("\n");
  const check = checkEnvExample(sample, metadata);
  assert.equal(check.ok, false);
  assert.equal(check.nonEmptySecrets.length, 1);
  assert.equal(check.nonEmptySecrets[0].key, "BOT_TOKEN");
  assert.equal(
    check.problems.some((p) => p.includes("placeholder-not-allowed")),
    false,
    "error report must not echo the secret value",
  );

  await withTempFile(sample, async (filePath) => {
    const { code, stderr } = await runCli([filePath]);
    assert.notEqual(code, 0);
    assert.match(stderr, /secret key must have an empty value in \.env\.example: BOT_TOKEN/);
  });
});
