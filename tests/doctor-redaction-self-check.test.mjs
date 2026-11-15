import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { formatCheckLine, runDoctor } from "../dist/doctor-cli.js";
import { Logger, runRedactionSelfCheck } from "../dist/logger.js";
import {
  buildSyntheticRedactionProbes,
  clearSecrets,
  registeredSecrets,
  registerSecret,
} from "../dist/redact.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

const VALID_MARKET_ID = "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";
const VALID_SQUAD_ID = "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY";
const VALID_AUTH = ["1234567890:", "AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"].join("");

test.afterEach(() => {
  Logger.reset();
  clearSecrets();
});

test("runRedactionSelfCheck exercises text and json formats and restores caller state", () => {
  const preExistingSecret = ["existing_secret_", "R".repeat(16)].join("");
  registerSecret(preExistingSecret);
  Logger.configure({ level: "warn", format: "json", secrets: [preExistingSecret] });

  const seenFormats = new Set();
  const result = runRedactionSelfCheck({
    inspectOutput: ({ surface, format, output }) => {
      if (surface === "logger" && format) {
        seenFormats.add(format);
      }
      return output;
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.formatsChecked, ["text", "json"]);
  assert.deepEqual([...seenFormats].sort(), ["json", "text"]);
  assert.equal(result.leakedFields.length, 0);
  assert.ok(result.probesRun >= 7);

  // Caller Logger configuration and registeredSecrets are preserved untouched
  assert.equal(Logger.getLevel(), "warn");
  assert.equal(Logger.getFormat(), "json");
  assert.deepEqual(registeredSecrets(), [preExistingSecret]);
});

test("runRedactionSelfCheck reports ONLY field names when a probe leaks in json or text", () => {
  const probes = buildSyntheticRedactionProbes();
  const botProbe = probes.find((p) => p.field === "bot_token");
  const queryProbe = probes.find((p) => p.field === "url_query_api_key");
  assert.ok(botProbe && queryProbe);

  const result = runRedactionSelfCheck({
    probes,
    inspectOutput: ({ surface, format, field, output }) => {
      if (surface === "logger" && format === "json" && field === "nested.bot_token") {
        return JSON.stringify({ nested: { bot_token: botProbe.secret } });
      }
      if (surface === "redactUrl" && field === "url_query_api_key") {
        return `https://rpc.example.invalid/soroban?key=${queryProbe.secret}`;
      }
      return output;
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.leakedFields, ["nested.bot_token", "url_query_api_key"]);

  const serialized = JSON.stringify(result);
  for (const probe of probes) {
    assert.equal(
      serialized.includes(probe.secret),
      false,
      `synthetic secret for ${probe.field} must never appear in self-check result`,
    );
  }
});

test("malformed or secret-tainted probe field names are sanitized to safe identifier", () => {
  const taintedSecret = ["tainted_probe_val_", "T".repeat(16)].join("");
  const result = runRedactionSelfCheck({
    probes: [
      {
        field: `bad field=${taintedSecret}`,
        secret: taintedSecret,
        sample: `leak ${taintedSecret}`,
        register: true,
      },
    ],
    inspectOutput: ({ field }) => (field === "unnamed_probe" ? taintedSecret : ""),
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.leakedFields, ["unnamed_probe"]);
  assert.equal(JSON.stringify(result).includes(taintedSecret), false);
});

test("runDoctor includes redaction-policy check (OK when clean, FAIL with field names only on leak)", async () => {
  await withTempDataDir(async ({ root: dir }) => {
    const envFile = path.join(dir, ".env");
    await writeFile(
      envFile,
      [
        `MARKET_CONTRACT_ID=${VALID_MARKET_ID}`,
        `SQUAD_CONTRACT_ID=${VALID_SQUAD_ID}`,
        `BOT_TOKEN=${VALID_AUTH}`,
        `TELEGRAM_CHAT_ID=-1001234567890`,
        `LOG_FORMAT=json`,
      ].join("\n"),
    );

    const okReport = await runDoctor({
      cwd: dir,
      nodeVersion: "v20.18.0",
      packageJsonPath: path.resolve("package.json"),
    });
    assert.equal(okReport.ok, true);
    const okCheck = okReport.checks.find((c) => c.name === "redaction-policy");
    assert.ok(okCheck);
    assert.equal(okCheck.status, "OK");
    assert.match(okCheck.message, /json, text/);

    // Simulate a leak in text format for authorization_bearer and stellar_seed
    const probes = buildSyntheticRedactionProbes();
    const bearerProbe = probes.find((p) => p.field === "authorization_bearer");
    const seedProbe = probes.find((p) => p.field === "stellar_seed");
    assert.ok(bearerProbe && seedProbe);

    const failReport = await runDoctor({
      cwd: dir,
      nodeVersion: "v20.18.0",
      packageJsonPath: path.resolve("package.json"),
      redactionSelfCheckOptions: {
        probes,
        inspectOutput: ({ surface, format, field, output }) => {
          if (surface === "logger" && format === "text" && field === "authorization_bearer") {
            return bearerProbe.secret;
          }
          if (surface === "redactError" && field === "stellar_seed") {
            return seedProbe.secret;
          }
          return output;
        },
      },
    });

    assert.equal(failReport.ok, false);
    const failCheck = failReport.checks.find((c) => c.name === "redaction-policy");
    assert.ok(failCheck);
    assert.equal(failCheck.status, "FAIL");
    assert.equal(
      failCheck.message,
      "Redaction policy self-check failed: leaked fields [authorization_bearer, stellar_seed]",
    );

    const formatted = formatCheckLine(failCheck);
    assert.match(formatted, /^\[FAIL\]\s+Redaction policy self-check failed: leaked fields \[authorization_bearer, stellar_seed\]$/);
    for (const probe of probes) {
      assert.equal(failCheck.message.includes(probe.secret), false);
      assert.equal(formatted.includes(probe.secret), false);
    }
    assert.equal(formatted.includes(VALID_AUTH), false);
  });
});
