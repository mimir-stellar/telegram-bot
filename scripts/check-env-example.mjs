#!/usr/bin/env node
/**
 * Verify that `.env.example` stays in sync with the configuration keys the bot
 * actually reads (`CONFIG_KEYS` / `configProvenance` in `dist/config.js`).
 *
 * Checks:
 *   1. Every key declared in `dist/config.js` metadata appears in `.env.example`
 *      (either commented or uncommented).
 *   2. Every key in `.env.example` is declared in `dist/config.js` metadata
 *      (no dead/stale keys that the code never reads).
 *   3. Every key marked `secret: true` in metadata appears in `.env.example`
 *      with an empty value only (`KEY=` or `# KEY=`).
 *
 * Exits 0 when in sync, 1 when drift or a non-empty secret placeholder is found.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ENV_EXAMPLE_PATH = path.resolve(__dirname, "../.env.example");
export const DEFAULT_DIST_CONFIG_PATH = path.resolve(__dirname, "../dist/config.js");

const UNCOMMENTED_LINE_RE = /^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/;
const COMMENTED_LINE_RE = /^#\s*([A-Z][A-Z0-9_]*)=(.*)$/;

/**
 * Prose comment detector for lines that happen to start with `# KEY=value ...`
 * in a sentence (e.g. `# MIMIR_PROFILE=mock selects the local mock profile...`).
 */
const PROSE_AFTER_VALUE_RE = /^\S+\s+(?:selects|is|are|for|when|that|to|in|on|with|defaults|overrides)\b/;

/**
 * Strip surrounding matching quotes from an env value if present.
 *
 * @param {string} raw
 * @returns {string}
 */
function normalizeValue(raw) {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Parse `.env.example` text into declarations (both commented and uncommented).
 *
 * @param {string} content
 * @returns {Array<{ key: string, value: string, commented: boolean, line: number }>}
 */
export function parseEnvExample(content) {
  const entries = [];
  const lines = String(content).split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const lineNumber = i + 1;
    const trimmed = lines[i].trim();
    if (!trimmed) continue;

    if (!trimmed.startsWith("#")) {
      const match = UNCOMMENTED_LINE_RE.exec(trimmed);
      if (match) {
        entries.push({
          key: match[1],
          value: normalizeValue(match[2]),
          commented: false,
          line: lineNumber,
        });
      }
      continue;
    }

    const match = COMMENTED_LINE_RE.exec(trimmed);
    if (!match) continue;

    const key = match[1];
    const rawValue = match[2].trim();
    if (PROSE_AFTER_VALUE_RE.test(rawValue)) continue;

    entries.push({
      key,
      value: normalizeValue(rawValue),
      commented: true,
      line: lineNumber,
    });
  }

  return entries;
}

/**
 * Load key metadata from compiled `dist/config.js`.
 *
 * @param {string} [distConfigPath]
 * @returns {Promise<Array<{ key: string, secret: boolean }>>}
 */
export async function loadKeyMetadata(distConfigPath = DEFAULT_DIST_CONFIG_PATH) {
  const mod = await import(pathToFileURL(distConfigPath).href);
  if (Array.isArray(mod.CONFIG_KEYS)) {
    return mod.CONFIG_KEYS.map((entry) => ({
      key: entry.key,
      secret: Boolean(entry.secret),
    }));
  }
  if (typeof mod.configProvenance === "function") {
    const provenance = mod.configProvenance();
    if (provenance && Array.isArray(provenance.entries)) {
      return provenance.entries.map((entry) => ({
        key: entry.key,
        secret: Boolean(entry.secret),
      }));
    }
  }
  throw new Error(
    `Could not load key metadata (CONFIG_KEYS or configProvenance) from ${distConfigPath}`,
  );
}

/**
 * Compare parsed `.env.example` entries against config key metadata.
 *
 * @param {string | Array<{ key: string, value: string, commented?: boolean, line?: number }>} exampleInput
 * @param {Array<{ key: string, secret: boolean }>} metadata
 * @returns {{
 *   ok: boolean,
 *   missingFromExample: string[],
 *   extraInExample: string[],
 *   nonEmptySecrets: Array<{ key: string, line: number | null }>,
 *   problems: string[]
 * }}
 */
export function checkEnvExample(exampleInput, metadata) {
  const entries =
    typeof exampleInput === "string" ? parseEnvExample(exampleInput) : exampleInput;

  const metaByKey = new Map();
  for (const item of metadata) {
    metaByKey.set(item.key, { key: item.key, secret: Boolean(item.secret) });
  }

  const exampleKeys = new Set(entries.map((entry) => entry.key));

  const missingFromExample = [];
  for (const key of metaByKey.keys()) {
    if (!exampleKeys.has(key)) {
      missingFromExample.push(key);
    }
  }
  missingFromExample.sort();

  const extraInExample = [];
  for (const key of exampleKeys) {
    if (!metaByKey.has(key)) {
      extraInExample.push(key);
    }
  }
  extraInExample.sort();

  const nonEmptySecrets = [];
  for (const entry of entries) {
    const spec = metaByKey.get(entry.key);
    if (spec?.secret && entry.value !== "") {
      nonEmptySecrets.push({ key: entry.key, line: entry.line ?? null });
    }
  }

  const problems = [];
  for (const key of missingFromExample) {
    problems.push(`missing from .env.example: ${key}`);
  }
  for (const key of extraInExample) {
    problems.push(`present in .env.example but never read by config: ${key}`);
  }
  for (const item of nonEmptySecrets) {
    const loc = item.line !== null ? ` (line ${item.line})` : "";
    problems.push(`secret key must have an empty value in .env.example: ${item.key}${loc}`);
  }

  return {
    ok: problems.length === 0,
    missingFromExample,
    extraInExample,
    nonEmptySecrets,
    problems,
  };
}

/**
 * Run the check against a `.env.example` file and `dist/config.js` module.
 *
 * @param {{ envExamplePath?: string, distConfigPath?: string }} [options]
 */
export async function runCheck(options = {}) {
  const envExamplePath = options.envExamplePath
    ? path.resolve(options.envExamplePath)
    : DEFAULT_ENV_EXAMPLE_PATH;
  const distConfigPath = options.distConfigPath
    ? path.resolve(options.distConfigPath)
    : DEFAULT_DIST_CONFIG_PATH;

  const [content, metadata] = await Promise.all([
    readFile(envExamplePath, "utf8"),
    loadKeyMetadata(distConfigPath),
  ]);

  return checkEnvExample(content, metadata);
}

async function main() {
  const envExampleArg = process.argv[2];
  const result = await runCheck(
    envExampleArg ? { envExamplePath: envExampleArg } : {},
  );

  if (!result.ok) {
    console.error(`.env.example drift detected (${result.problems.length} problem(s)):`);
    for (const problem of result.problems) {
      console.error(`  - ${problem}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(".env.example is in sync with configuration keys.");
}

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((err) => {
    console.error(`check-env-example failed: ${err?.message ?? err}`);
    process.exitCode = 1;
  });
}
