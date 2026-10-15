/**
 * Golden corpus tests: verify every event type in both render modes against committed golden outputs.
 * Closes #526.
 */

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { formatEvent, formatPlainTextEvent } from "../dist/notifications/format.js";
import {
  EVENT_DEFINITIONS,
  GOLDEN_CONFIG,
  generateGoldenCorpus,
  hydrateEvent,
} from "../scripts/gen-golden-corpus.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = path.join(__dirname, "fixtures/golden");

// If invoked with --update, regenerate the corpus files before testing
if (process.argv.includes("--update")) {
  await generateGoldenCorpus();
}

test("golden corpus covers every market and squad event name", async () => {
  const files = await readdir(GOLDEN_DIR);
  const jsonFiles = files.filter((f) => f.endsWith(".json"));
  const foundEvents = new Set(jsonFiles.map((f) => f.replace(/\.json$/, "")));

  for (const def of EVENT_DEFINITIONS) {
    assert.ok(
      foundEvents.has(def.name),
      `Missing golden fixture for event "${def.name}" (${def.source})`
    );
  }

  assert.equal(
    foundEvents.size,
    EVENT_DEFINITIONS.length,
    `Expected ${EVENT_DEFINITIONS.length} golden event fixtures, found ${foundEvents.size}`
  );
});

test("all golden fixtures re-render with bit-exact parity in both MarkdownV2 and Plain text", async () => {
  const files = await readdir(GOLDEN_DIR);
  const jsonFiles = files.filter((f) => f.endsWith(".json"));

  let totalCasesChecked = 0;

  for (const filename of jsonFiles) {
    const rawContent = await readFile(path.join(GOLDEN_DIR, filename), "utf8");
    const corpus = JSON.parse(rawContent);

    assert.ok(Array.isArray(corpus.cases), `${filename} must contain cases array`);
    assert.ok(corpus.cases.length > 0, `${filename} must have at least one case`);

    for (const c of corpus.cases) {
      totalCasesChecked += 1;
      const hydrated = hydrateEvent(c.event);

      // 1. Check MarkdownV2 rendering
      const actualMarkdown = formatEvent(GOLDEN_CONFIG, hydrated);
      assert.equal(
        actualMarkdown,
        c.expectedMarkdown,
        `Markdown mismatch in ${filename} case "${c.caseId}": ${c.description}`
      );

      // 2. Check Plain Text rendering
      const actualPlain = formatPlainTextEvent(GOLDEN_CONFIG, hydrated);
      assert.equal(
        actualPlain,
        c.expectedPlain,
        `Plain text mismatch in ${filename} case "${c.caseId}": ${c.description}`
      );
    }
  }

  assert.ok(totalCasesChecked >= 30, `Expected at least 30 edge cases, tested ${totalCasesChecked}`);
});
