import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  HEALTH_REPORT_SCHEMA_VERSION,
  checkHealthPayloadCompatibility,
  compareHealthSchemas,
} from "../dist/health.js";
import {
  buildDeterministicFixture,
  coldStartPollerStatus,
  degradedPollerStatus,
  healthyPollerStatus,
} from "./helpers/health-compat-fixtures.mjs";
import { validate } from "./helpers/json-schema-lite.mjs";

const currentSchema = JSON.parse(
  readFileSync(new URL("../docs/schemas/health-report.schema.json", import.meta.url), "utf8"),
);
const v1Schema = JSON.parse(
  readFileSync(new URL("../docs/schemas/health-report.v1.schema.json", import.meta.url), "utf8"),
);

function loadFixture(name) {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/health/${name}`, import.meta.url), "utf8"),
  );
}

test("current schema stays backward-compatible with the published v1 baseline contract", () => {
  assert.equal(HEALTH_REPORT_SCHEMA_VERSION, 1);
  // Both schemas must stay within json-schema-lite's supported subset
  assert.deepEqual(validate(v1Schema, loadFixture("v1-healthy.json")), []);
  assert.deepEqual(validate(currentSchema, loadFixture("v1-healthy.json")), []);

  const diff = compareHealthSchemas(v1Schema, currentSchema);
  assert.equal(diff.compatible, true);
  assert.deepEqual(diff.breaking, []);
  assert.ok(diff.classification === "identical" || diff.classification === "additive");
});

test("deterministic v1 fixtures match live buildHealthReport output and pass strict + compat checks", () => {
  const cases = [
    ["v1-healthy.json", healthyPollerStatus()],
    ["v1-degraded.json", degradedPollerStatus()],
    ["v1-cold-start.json", coldStartPollerStatus()],
  ];

  for (const [fileName, status] of cases) {
    const expected = loadFixture(fileName);
    const live = buildDeterministicFixture(status);
    assert.deepEqual(live, expected, `${fileName} must match deterministic buildHealthReport`);
    assert.equal(live.schemaVersion, 1);
    assert.deepEqual(validate(currentSchema, live), [], `${fileName} strict schema`);

    const compat = checkHealthPayloadCompatibility(v1Schema, live);
    assert.equal(compat.compatible, true);
    assert.equal(compat.classification, "identical");
    assert.deepEqual(compat.additive, []);
    assert.deepEqual(compat.breaking, []);
  }
});

test("checkHealthPayloadCompatibility distinguishes additive fields from breaking changes", () => {
  const additiveFixture = loadFixture("v1-additive-forward.json");

  // Closed producer validation flags undocumented fields so schemas stay up to date
  const strictErrors = validate(v1Schema, additiveFixture);
  assert.equal(strictErrors.length, 3);

  // Versioned consumer compatibility check classifies those fields as additive (compatible)
  const additiveRes = checkHealthPayloadCompatibility(v1Schema, additiveFixture);
  assert.equal(additiveRes.compatible, true);
  assert.equal(additiveRes.classification, "additive");
  assert.deepEqual(additiveRes.breaking, []);
  assert.deepEqual(
    additiveRes.additive.map((i) => [i.path, i.code]),
    [
      ["$.instanceRegion", "added_property"],
      ["$.poller.lastFlushAgeMs", "added_property"],
      ["$.poller.targets[0].rpcLatencyBucket", "added_property"],
    ],
  );

  // Breaking v2 fixture reports incompatible_schema_version, enum_mismatch, and missing_required_property
  const breakingFixture = loadFixture("v2-breaking-sample.json");
  const breakingRes = checkHealthPayloadCompatibility(v1Schema, breakingFixture);
  assert.equal(breakingRes.compatible, false);
  assert.equal(breakingRes.classification, "breaking");
  assert.deepEqual(breakingRes.additive, []);
  assert.deepEqual(
    breakingRes.breaking.map((i) => [i.path, i.code]),
    [
      ["$.poller", "missing_required_property"],
      ["$.schemaVersion", "incompatible_schema_version"],
      ["$.status", "enum_mismatch"],
    ],
  );
});

test("renaming a field surfaces both added_property and missing_required_property as overall breaking", () => {
  const renamed = loadFixture("v1-healthy.json");
  renamed.poller.cycleCount = renamed.poller.cycles;
  delete renamed.poller.cycles;

  const res = checkHealthPayloadCompatibility(v1Schema, renamed);
  assert.equal(res.compatible, false);
  assert.equal(res.classification, "breaking");
  assert.deepEqual(
    res.additive.map((i) => [i.path, i.code]),
    [["$.poller.cycleCount", "added_property"]],
  );
  assert.deepEqual(
    res.breaking.map((i) => [i.path, i.code]),
    [["$.poller", "missing_required_property"]],
  );
});

test("payload boundary violations (type, minimum, date-time format) are classified as breaking", () => {
  const broken = loadFixture("v1-healthy.json");
  broken.uptimeMs = -1;
  broken.checkedAt = "not-a-timestamp";
  broken.poller.running = "yes";

  const res = checkHealthPayloadCompatibility(v1Schema, broken);
  assert.equal(res.compatible, false);
  assert.equal(res.classification, "breaking");
  assert.deepEqual(
    res.breaking.map((i) => [i.path, i.code]),
    [
      ["$.checkedAt", "format_mismatch"],
      ["$.poller.running", "type_mismatch"],
      ["$.uptimeMs", "minimum_violation"],
    ],
  );
});

test("compareHealthSchemas classifies additive schema evolution separately from breaking schema changes", () => {
  // 1. Additive schema evolution: adding properties at root, poller, and targets[]
  const additiveCandidate = structuredClone(v1Schema);
  additiveCandidate.properties.deploymentSlot = { type: "string" };
  additiveCandidate.required.push("deploymentSlot");
  additiveCandidate.properties.poller.properties.lastFlushAgeMs = {
    type: ["integer", "null"],
    minimum: 0,
  };
  additiveCandidate.properties.poller.required.push("lastFlushAgeMs");
  additiveCandidate.properties.poller.properties.targets.items.properties.lagLedgers = {
    type: "integer",
    minimum: 0,
  };
  additiveCandidate.properties.poller.properties.targets.items.required.push("lagLedgers");

  const additiveDiff = compareHealthSchemas(v1Schema, additiveCandidate);
  assert.equal(additiveDiff.compatible, true);
  assert.equal(additiveDiff.classification, "additive");
  assert.deepEqual(additiveDiff.breaking, []);
  assert.deepEqual(
    additiveDiff.additive.map((i) => i.path),
    ["$.deploymentSlot", "$.poller.lastFlushAgeMs", "$.poller.targets[].lagLedgers"],
  );

  // 2. Breaking schema changes: dropping required field, widening non-null to null,
  //    introducing unknown enum variant, bumping schemaVersion, relaxing minimum, dropping format
  const breakingCandidate = structuredClone(v1Schema);
  breakingCandidate.properties.schemaVersion.enum = [2];
  breakingCandidate.properties.status.enum = ["ok", "degraded", "stopped", "draining"];
  breakingCandidate.properties.uptimeMs.minimum = -5;
  delete breakingCandidate.properties.checkedAt.format;
  breakingCandidate.properties.network.type = ["string", "null"];
  breakingCandidate.properties.poller.required =
    breakingCandidate.properties.poller.required.filter((k) => k !== "cycles");

  const breakingDiff = compareHealthSchemas(v1Schema, breakingCandidate);
  assert.equal(breakingDiff.compatible, false);
  assert.equal(breakingDiff.classification, "breaking");
  assert.deepEqual(
    breakingDiff.breaking.map((i) => [i.path, i.code]),
    [
      ["$.checkedAt", "format_mismatch"],
      ["$.network", "type_mismatch"],
      ["$.poller.cycles", "missing_required_property"],
      ["$.schemaVersion", "incompatible_schema_version"],
      ["$.status", "enum_mismatch"],
      ["$.uptimeMs", "minimum_violation"],
    ],
  );
});
