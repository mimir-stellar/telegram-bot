import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  findCaseCollisions,
  formatCheckLine,
  parseSemver,
  runDoctor,
  runRedactionSelfCheck,
  satisfiesNodeEngine,
} from "../dist/doctor-cli.js";
import { Logger } from "../dist/logger.js";

const execFileP = promisify(execFile);

async function withTempDir(fn) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mimir-doctor-test-"));
  try {
    await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const VALID_MARKET_ID = "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";
const VALID_SQUAD_ID = "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY";
const validTestAuth = ["1234567890:", "AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"].join("");
const secretTestAuth = ["9876543210:", "SECRET_TOKEN_VALUE_NEVER_PRINT_ME_XYZ"].join("");

test("satisfiesNodeEngine correctly checks semver constraints", () => {
  assert.equal(satisfiesNodeEngine("v20.18.0", ">=20"), true);
  assert.equal(satisfiesNodeEngine("v22.1.0", ">=20"), true);
  assert.equal(satisfiesNodeEngine("v18.19.0", ">=20"), false);
  assert.equal(satisfiesNodeEngine("v19.9.0", ">=20"), false);
  assert.equal(satisfiesNodeEngine("20.0.0", ">=20.0.0"), true);
  assert.equal(satisfiesNodeEngine("20.1.0", "^20.0.0"), true);
  assert.equal(satisfiesNodeEngine("21.0.0", "^20.0.0"), false);
});

test("parseSemver handles versions with or without 'v'", () => {
  assert.deepEqual(parseSemver("v20.18.2"), [20, 18, 2]);
  assert.deepEqual(parseSemver("20.18"), [20, 18, 0]);
  assert.deepEqual(parseSemver("invalid"), null);
});

test("runDoctor succeeds with all checks OK on valid environment", async () => {
  await withTempDir(async (dir) => {
    const envFile = path.join(dir, ".env");
    await writeFile(
      envFile,
      [
        `MARKET_CONTRACT_ID=${VALID_MARKET_ID}`,
        `SQUAD_CONTRACT_ID=${VALID_SQUAD_ID}`,
        `BOT_TOKEN=${validTestAuth}`,
        `TELEGRAM_CHAT_ID=-1001234567890`,
      ].join("\n"),
    );

    const report = await runDoctor({
      cwd: dir,
      nodeVersion: "v20.18.0",
      packageJsonPath: path.resolve("package.json"),
    });

    assert.equal(report.ok, true);
    assert.equal(report.checks.some((c) => c.status === "FAIL"), false);

    const envCheck = report.checks.find((c) => c.name === "env-file");
    assert.equal(envCheck.status, "OK");

    const cursorCheck = report.checks.find((c) => c.name === "cursor-directory");
    assert.equal(cursorCheck.status, "OK");

    const marketCheck = report.checks.find((c) => c.name === "MARKET_CONTRACT_ID");
    assert.equal(marketCheck.status, "OK");

    const tokenCheck = report.checks.find((c) => c.name === "BOT_TOKEN");
    assert.equal(tokenCheck.status, "OK");
  });
});

test("runDoctor reports FAIL when .env file is missing", async () => {
  await withTempDir(async (dir) => {
    const report = await runDoctor({
      cwd: dir,
      nodeVersion: "v20.18.0",
      packageJsonPath: path.resolve("package.json"),
      env: {
        MARKET_CONTRACT_ID: VALID_MARKET_ID,
        SQUAD_CONTRACT_ID: VALID_SQUAD_ID,
      },
    });

    assert.equal(report.ok, false);
    const envCheck = report.checks.find((c) => c.name === "env-file");
    assert.equal(envCheck.status, "FAIL");
    assert.match(envCheck.message, /missing/);
  });
});

test("runDoctor reports FAIL on incompatible Node version", async () => {
  await withTempDir(async (dir) => {
    const envFile = path.join(dir, ".env");
    await writeFile(
      envFile,
      `MARKET_CONTRACT_ID=${VALID_MARKET_ID}\nSQUAD_CONTRACT_ID=${VALID_SQUAD_ID}\n`,
    );

    const report = await runDoctor({
      cwd: dir,
      nodeVersion: "v18.17.0",
      packageJsonPath: path.resolve("package.json"),
    });

    assert.equal(report.ok, false);
    const nodeCheck = report.checks.find((c) => c.name === "node-version");
    assert.equal(nodeCheck.status, "FAIL");
    assert.match(nodeCheck.message, /does not satisfy/);
  });
});

test("runDoctor reports FAIL when contract ID format is invalid", async () => {
  await withTempDir(async (dir) => {
    const envFile = path.join(dir, ".env");
    await writeFile(
      envFile,
      `MARKET_CONTRACT_ID=NOT_A_VALID_CONTRACT_ID\nSQUAD_CONTRACT_ID=${VALID_SQUAD_ID}\n`,
    );

    const report = await runDoctor({
      cwd: dir,
      nodeVersion: "v20.18.0",
      packageJsonPath: path.resolve("package.json"),
    });

    assert.equal(report.ok, false);
    const marketCheck = report.checks.find((c) => c.name === "MARKET_CONTRACT_ID");
    assert.equal(marketCheck.status, "FAIL");
    assert.match(marketCheck.message, /not a Soroban contract ID/);
  });
});

test("runDoctor reports FAIL when contract ID is missing", async () => {
  await withTempDir(async (dir) => {
    const envFile = path.join(dir, ".env");
    await writeFile(envFile, `SQUAD_CONTRACT_ID=${VALID_SQUAD_ID}\n`);

    const report = await runDoctor({
      cwd: dir,
      nodeVersion: "v20.18.0",
      packageJsonPath: path.resolve("package.json"),
    });

    assert.equal(report.ok, false);
    const marketCheck = report.checks.find((c) => c.name === "MARKET_CONTRACT_ID");
    assert.equal(marketCheck.status, "FAIL");
    assert.match(marketCheck.message, /missing or empty/);
  });
});

test("runDoctor checks bot token only for shape and never outputs its value", async () => {
  await withTempDir(async (dir) => {
    const envFile = path.join(dir, ".env");
    await writeFile(
      envFile,
      [
        `MARKET_CONTRACT_ID=${VALID_MARKET_ID}`,
        `SQUAD_CONTRACT_ID=${VALID_SQUAD_ID}`,
        `BOT_TOKEN=${secretTestAuth}`,
      ].join("\n"),
    );

    const report = await runDoctor({
      cwd: dir,
      nodeVersion: "v20.18.0",
      packageJsonPath: path.resolve("package.json"),
    });

    assert.equal(report.ok, true);
    const tokenCheck = report.checks.find((c) => c.name === "BOT_TOKEN");
    assert.equal(tokenCheck.status, "OK");

    // Verify token value NEVER appears in any check message or formatted line
    for (const check of report.checks) {
      assert.equal(check.message.includes(secretTestAuth), false);
      const line = formatCheckLine(check);
      assert.equal(line.includes(secretTestAuth), false);
    }
  });
});

test("runDoctor reports FAIL on malformed bot token without leaking the value", async () => {
  await withTempDir(async (dir) => {
    const badAuth = ["BAD_AUTH_VALUE", "_WITHOUT_COLON_OR_DIGITS"].join("");
    const envFile = path.join(dir, ".env");
    await writeFile(
      envFile,
      [
        `MARKET_CONTRACT_ID=${VALID_MARKET_ID}`,
        `SQUAD_CONTRACT_ID=${VALID_SQUAD_ID}`,
        `BOT_TOKEN=${badAuth}`,
      ].join("\n"),
    );

    const report = await runDoctor({
      cwd: dir,
      nodeVersion: "v20.18.0",
      packageJsonPath: path.resolve("package.json"),
    });

    assert.equal(report.ok, false);
    const tokenCheck = report.checks.find((c) => c.name === "BOT_TOKEN");
    assert.equal(tokenCheck.status, "FAIL");
    assert.equal(tokenCheck.message.includes(badAuth), false);

    const line = formatCheckLine(tokenCheck);
    assert.equal(line.includes(badAuth), false);
  });
});

test("runDoctor reports WARN when bot token is unset and exits 0 if other checks pass", async () => {
  await withTempDir(async (dir) => {
    const envFile = path.join(dir, ".env");
    await writeFile(
      envFile,
      [
        `MARKET_CONTRACT_ID=${VALID_MARKET_ID}`,
        `SQUAD_CONTRACT_ID=${VALID_SQUAD_ID}`,
      ].join("\n"),
    );

    const report = await runDoctor({
      cwd: dir,
      nodeVersion: "v20.18.0",
      packageJsonPath: path.resolve("package.json"),
    });

    assert.equal(report.ok, true);
    const tokenCheck = report.checks.find((c) => c.name === "BOT_TOKEN");
    assert.equal(tokenCheck.status, "WARN");
  });
});

test("runDoctor accepts fake env objects via options", async () => {
  await withTempDir(async (dir) => {
    const report = await runDoctor({
      cwd: dir,
      envPath: path.join(dir, ".env.fake"),
      env: {
        MARKET_CONTRACT_ID: VALID_MARKET_ID,
        SQUAD_CONTRACT_ID: VALID_SQUAD_ID,
        BOT_TOKEN: validTestAuth,
        TELEGRAM_CHAT_ID: "-10099999",
      },
      nodeVersion: "v20.18.0",
      packageJsonPath: path.resolve("package.json"),
    });

    // .env.fake does not exist on disk, so env-file check will FAIL
    const envCheck = report.checks.find((c) => c.name === "env-file");
    assert.equal(envCheck.status, "FAIL");

    // But contract IDs supplied via fake env pass validation
    const marketCheck = report.checks.find((c) => c.name === "MARKET_CONTRACT_ID");
    assert.equal(marketCheck.status, "OK");
  });
});

test("formatCheckLine formats one line per check with OK/WARN/FAIL", () => {
  const okLine = formatCheckLine({ name: "test", status: "OK", message: "check succeeded" });
  assert.match(okLine, /^\[OK\]/);
  assert.match(okLine, /check succeeded/);

  const warnLine = formatCheckLine({ name: "test", status: "WARN", message: "check warning" });
  assert.match(warnLine, /^\[WARN\]/);

  const failLine = formatCheckLine({ name: "test", status: "FAIL", message: "check failed" });
  assert.match(failLine, /^\[FAIL\]/);
});

test("CLI execution runs with tsx without network and exits non-zero on FAIL", async () => {
  await withTempDir(async (dir) => {
    // Missing .env directory -> should exit non-zero
    const child = execFileP(
      process.execPath,
      [path.resolve("./node_modules/tsx/dist/cli.mjs"), path.resolve("src/doctor-cli.ts")],
      {
        cwd: dir,
      },
    );

    await assert.rejects(child, (err) => {
      assert.equal(err.code, 1);
      assert.match(err.stdout, /FAIL/);
      return true;
    });
  });
});

test("CLI execution exits 0 on valid configuration", async () => {
  await withTempDir(async (dir) => {
    const envFile = path.join(dir, ".env");
    await writeFile(
      envFile,
      [
        `MARKET_CONTRACT_ID=${VALID_MARKET_ID}`,
        `SQUAD_CONTRACT_ID=${VALID_SQUAD_ID}`,
        `BOT_TOKEN=${validTestAuth}`,
        `TELEGRAM_CHAT_ID=-1001234567890`,
      ].join("\n"),
    );

    // Provide package.json in temp dir with engines
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ engines: { node: ">=20" } }),
    );

    const { stdout } = await execFileP(
      process.execPath,
      [path.resolve("./node_modules/tsx/dist/cli.mjs"), path.resolve("src/doctor-cli.ts")],
      {
        cwd: dir,
      },
    );

    assert.match(stdout, /\[OK\]/);
    assert.match(stdout, /Redaction policy self-check passed/);
    assert.doesNotMatch(stdout, /\[FAIL\]/);
  });
});

// ── Case-collision helper unit tests ─────────────────────────────────────────

test("findCaseCollisions returns empty array when no files collide", () => {
  const files = ["src/foo.ts", "src/bar.ts", "src/baz/qux.ts"];
  assert.deepEqual(findCaseCollisions(files), []);
});

test("findCaseCollisions detects a simple two-file collision", () => {
  const files = ["src/Foo.ts", "src/foo.ts"];
  const result = findCaseCollisions(files);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], ["src/Foo.ts", "src/foo.ts"]);
});

test("findCaseCollisions detects collisions across directories", () => {
  const files = ["src/Utils.ts", "src/utils.ts", "src/index.ts"];
  const result = findCaseCollisions(files);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], ["src/Utils.ts", "src/utils.ts"]);
  // non-colliding file is not reported
  assert.ok(!result.flat().includes("src/index.ts"));
});

test("findCaseCollisions detects multiple independent collision groups", () => {
  const files = ["src/Foo.ts", "src/foo.ts", "lib/Bar.ts", "lib/bar.ts", "readme.md"];
  const result = findCaseCollisions(files);
  assert.equal(result.length, 2);
  // groups are sorted by first member
  assert.deepEqual(result[0], ["lib/Bar.ts", "lib/bar.ts"]);
  assert.deepEqual(result[1], ["src/Foo.ts", "src/foo.ts"]);
});

test("findCaseCollisions normalises Windows backslash separators", () => {
  const files = ["src\\Foo.ts", "src\\foo.ts"];
  const result = findCaseCollisions(files);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], ["src/Foo.ts", "src/foo.ts"]);
});

test("findCaseCollisions handles an empty file list", () => {
  assert.deepEqual(findCaseCollisions([]), []);
});

test("findCaseCollisions result is independent of input order", () => {
  const forward = findCaseCollisions(["src/Foo.ts", "src/foo.ts"]);
  const reversed = findCaseCollisions(["src/foo.ts", "src/Foo.ts"]);
  assert.deepEqual(forward, reversed);
});

// ── Case-collision integration tests (via runDoctor + sourceFiles injection) ──

test("runDoctor reports OK for case-collisions when no collisions exist", async () => {
  await withTempDir(async (dir) => {
    const report = await runDoctor({
      cwd: dir,
      nodeVersion: "v20.18.0",
      packageJsonPath: path.resolve("package.json"),
      sourceFiles: ["src/index.ts", "src/bot.ts", "src/config.ts"],
    });
    const check = report.checks.find((c) => c.name === "case-collisions");
    assert.ok(check, "case-collisions check must be present");
    assert.equal(check.status, "OK");
    assert.match(check.message, /No case-insensitive filename collisions/);
  });
});

test("runDoctor reports FAIL for case-collisions when collision exists", async () => {
  await withTempDir(async (dir) => {
    const report = await runDoctor({
      cwd: dir,
      nodeVersion: "v20.18.0",
      packageJsonPath: path.resolve("package.json"),
      sourceFiles: ["src/Foo.ts", "src/foo.ts", "src/bar.ts"],
    });
    const check = report.checks.find((c) => c.name === "case-collisions");
    assert.ok(check, "case-collisions check must be present");
    assert.equal(check.status, "FAIL");
    assert.match(check.message, /Case-insensitive filename collisions detected/);
    assert.match(check.message, /src\/Foo\.ts/);
    assert.match(check.message, /src\/foo\.ts/);
    // A FAIL check makes the overall report not ok
    assert.equal(report.ok, false);
  });
});

test("runDoctor reports FAIL for case-collisions and ok=false overrides passing env checks", async () => {
  await withTempDir(async (dir) => {
    const envFile = path.join(dir, ".env");
    await writeFile(
      envFile,
      [
        `MARKET_CONTRACT_ID=${VALID_MARKET_ID}`,
        `SQUAD_CONTRACT_ID=${VALID_SQUAD_ID}`,
        `BOT_TOKEN=${validTestAuth}`,
        `TELEGRAM_CHAT_ID=-1001234567890`,
      ].join("\n"),
    );

    const report = await runDoctor({
      cwd: dir,
      nodeVersion: "v20.18.0",
      packageJsonPath: path.resolve("package.json"),
      sourceFiles: ["src/Handler.ts", "src/handler.ts"],
    });

    // All env checks pass
    assert.equal(report.checks.find((c) => c.name === "BOT_TOKEN")?.status, "OK");
    // But the case-collision check fails
    const check = report.checks.find((c) => c.name === "case-collisions");
    assert.equal(check.status, "FAIL");
    // So the overall report is not ok
    assert.equal(report.ok, false);
  });
});

test("runDoctor reports WARN for case-collisions when git ls-files is unavailable", async () => {
  await withTempDir(async (dir) => {
    // dir has no git repo; listTrackedFiles will fail.
    // We simulate this by NOT passing sourceFiles (so the real git path runs)
    // and running in a directory outside any git repo.
    const report = await runDoctor({
      cwd: dir,
      nodeVersion: "v20.18.0",
      packageJsonPath: path.resolve("package.json"),
      // no sourceFiles -> falls through to listTrackedFiles(dir)
      // dir is a fresh tmpdir with no git repo -> git exits non-zero
    });
    const check = report.checks.find((c) => c.name === "case-collisions");
    assert.ok(check, "case-collisions check must be present");
    assert.equal(check.status, "WARN");
    assert.match(check.message, /Case-collision check skipped/);
  });
});

test("runDoctor case-collisions check reports each colliding pair in the message", async () => {
  await withTempDir(async (dir) => {
    const report = await runDoctor({
      cwd: dir,
      nodeVersion: "v20.18.0",
      packageJsonPath: path.resolve("package.json"),
      sourceFiles: ["src/Alpha.ts", "src/alpha.ts", "src/Beta.ts", "src/beta.ts"],
    });
    const check = report.checks.find((c) => c.name === "case-collisions");
    assert.equal(check.status, "FAIL");
    // Both collision groups must appear in the message
    assert.match(check.message, /Alpha/);
    assert.match(check.message, /alpha/);
    assert.match(check.message, /Beta/);
    assert.match(check.message, /beta/);
  });
});
