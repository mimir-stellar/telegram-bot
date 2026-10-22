#!/usr/bin/env node
/**
 * scripts/untested-modules.mjs
 *
 * Reports source modules under src/ that no test file imports from dist/,
 * so contributors can find modules with zero direct test coverage.
 *
 *   - Scans every .ts file under src/ for candidate modules.
 *   - Scans every .mjs file under tests/ for dist import specifiers.
 *   - Respects the c8.exclude list from package.json.
 *   - Prints never-imported modules, sorted and deterministic.
 *
 * Usage:
 *   node scripts/untested-modules.mjs [--json] [--root=DIR | --root DIR]
 *
 *   --json  print the result as a JSON array
 *   --root  run against DIR instead of the current working directory
 *
 * Exit code 0 on success.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const SRC_DIR = "src";
const TESTS_DIR = "tests";
const DIST_DIR = "dist";
const SRC_EXT = ".ts";
const JS_EXT = ".js";

const USAGE = `Usage: node scripts/untested-modules.mjs [--json] [--root=DIR | --root DIR]

  --json  print the result as a JSON array
  --root  run against DIR instead of the current working directory`;

function parseArgs(argv) {
  let root = process.cwd();
  let json = false;
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      json = true;
    } else if (arg.startsWith("--root=")) {
      root = arg.slice("--root=".length);
    } else if (arg === "--root") {
      root = argv[index + 1];
      if (root === undefined) throw new Error("--root requires a directory");
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(USAGE + "\n");
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { root, json };
}

function readPackageJson(root) {
  return JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
}

/**
 * Convert a c8-style glob pattern to a RegExp over posix relative paths.
 * Supports `**`, `*`, and `?`; sufficient for the c8.exclude patterns in use.
 */
function globToRegExp(pattern) {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      re += ".*";
      i += 2;
      if (pattern[i] === "/") {
        re += "(?:.*/)?";
        i += 1;
      }
    } else if (c === "*") {
      re += "[^/]*";
      i += 1;
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else if (".+^${}()|[]\\".includes(c)) {
      re += "\\" + c;
      i += 1;
    } else {
      re += c;
      i += 1;
    }
  }
  return new RegExp("^" + re + "$");
}

function matchesAny(relativePath, patterns) {
  return patterns.some((pattern) => globToRegExp(pattern).test(relativePath));
}

function walkFiles(dir, root, ext, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, root, ext, out);
    } else if (entry.isFile() && entry.name.endsWith(ext)) {
      out.push(path.relative(root, full).split(path.sep).join("/"));
    }
  }
}

function candidateModules(root, excludePatterns) {
  const modules = [];
  walkFiles(path.join(root, SRC_DIR), root, SRC_EXT, modules);
  return modules.filter((module) => !matchesAny(module, excludePatterns));
}

/**
 * Map an import specifier to a src-relative module path, e.g.
 * "../dist/notifications/format.js" -> "src/notifications/format.ts".
 * Returns null for specifiers that do not resolve into root/dist/.
 */
function specifierToSource(root, testFile, specifier) {
  if (!specifier.startsWith(".")) return null;
  const resolved = path.resolve(path.dirname(testFile), specifier);
  const distRoot = path.join(root, DIST_DIR);
  const distPrefix = distRoot + path.sep;
  let relative;
  if (resolved === distRoot) {
    return null;
  } else if (resolved.startsWith(distPrefix)) {
    relative = path.relative(distRoot, resolved);
  } else {
    return null;
  }
  if (!relative.endsWith(JS_EXT)) return null;
  return (
    SRC_DIR + "/" + relative.slice(0, -JS_EXT.length) + SRC_EXT
  ).split(path.sep).join("/");
}

const IMPORT_FROM = /from\s*["']([^"']+)["']/g;

function importedModules(root) {
  const imported = new Set();
  const testFiles = [];
  walkFiles(path.join(root, TESTS_DIR), root, ".mjs", testFiles);
  for (const testFile of testFiles) {
    const full = path.join(root, testFile);
    const content = readFileSync(full, "utf8");
    let match;
    while ((match = IMPORT_FROM.exec(content)) !== null) {
      const source = specifierToSource(root, full, match[1]);
      if (source) imported.add(source);
    }
  }
  return imported;
}

function main(argv) {
  const { root, json } = parseArgs(argv);
  const pkg = readPackageJson(root);
  const excludePatterns = Array.isArray(pkg.c8?.exclude)
    ? pkg.c8.exclude
    : [];
  const candidates = candidateModules(root, excludePatterns);
  const imported = importedModules(root);
  const untested = candidates
    .filter((module) => !imported.has(module))
    .sort();

  if (json) {
    process.stdout.write(JSON.stringify(untested) + "\n");
  } else {
    for (const module of untested) {
      process.stdout.write(module + "\n");
    }
  }
  return 0;
}

try {
  process.exitCode = main(process.argv);
} catch (error) {
  process.stderr.write(
    error instanceof Error ? error.message : String(error) + "\n",
  );
  process.exit(1);
}
