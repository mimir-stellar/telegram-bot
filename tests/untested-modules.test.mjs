/**
 * tests/untested-modules.test.mjs
 *
 * Covers scripts/untested-modules.mjs against a scratch tree with one
 * covered module, one uncovered module, and one c8.excluded module.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const SCRIPT = path.join(ROOT, "scripts", "untested-modules.mjs");

function write(file, content) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, "utf8");
}

function runScript(tmp, ...extraArgs) {
  return spawnSync(
    process.execPath,
    [SCRIPT, "--root", tmp, ...extraArgs],
    { encoding: "utf8" },
  );
}

test("untested-modules reports only modules no test imports", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "untested-modules-"));
  try {
    write(
      path.join(tmp, "package.json"),
      JSON.stringify({
        name: "temp",
        c8: {
          include: ["src/**/*.ts"],
          exclude: ["src/excluded.ts"],
        },
      }),
    );
    write(path.join(tmp, "src", "covered.ts"), "export const covered = 1;\n");
    write(
      path.join(tmp, "src", "uncovered.ts"),
      "export const uncovered = 1;\n",
    );
    write(path.join(tmp, "src", "excluded.ts"), "export const excluded = 1;\n");
    write(
      path.join(tmp, "tests", "covered.test.mjs"),
      'import { covered } from "../dist/covered.js";\nassert.equal(covered, 1);\n',
    );

    const text = runScript(tmp);
    assert.equal(text.status, 0, text.stderr);
    const lines = text.stdout.split("\n").filter(Boolean);
    assert.equal(lines.includes("src/uncovered.ts"), true, "uncovered module missing");
    assert.equal(lines.includes("src/covered.ts"), false, "covered module reported");
    assert.equal(
      lines.includes("src/excluded.ts"),
      false,
      "c8.excluded module reported",
    );
    assert.deepEqual(
      [...lines].sort(),
      lines,
      "output must be sorted",
    );

    const json = runScript(tmp, "--json");
    assert.equal(json.status, 0, json.stderr);
    const data = JSON.parse(json.stdout);
    assert.deepEqual(data, ["src/uncovered.ts"], "json output mismatch");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
