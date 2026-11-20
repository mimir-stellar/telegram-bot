/*
 * Offline cursor backup and restore command. It never contacts Stellar or
 * Telegram; restore uses the normal instance lock to exclude a running poller.
 */

import { randomUUID } from "node:crypto";
import { access, link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { pathToFileURL } from "node:url";

import { acquireInstanceLock } from "./instanceLock.js";
import { checkCursorCas, cursorDigest, parseAndMigrateCursorFile } from "./poller.js";

export const CURSOR_USAGE =
  "usage: npm run cursor -- <inspect|backup|restore> [--file PATH] [--out PATH|--from PATH] [--if-match DIGEST] [--expected-source-digest DIGEST] [--force] [--json]";

export class CursorConflictError extends Error {
  readonly code = "CURSOR_CONFLICT";
  readonly target: "live" | "source";
  readonly expected: string | null;
  readonly actual: string | null;

  constructor(
    target: "live" | "source",
    expected: string | null,
    actual: string | null,
    reason: string,
  ) {
    super(`conflict: ${target} cursor file changed since inspection (${reason}); live cursor preserved`);
    this.name = "CursorConflictError";
    this.target = target;
    this.expected = expected;
    this.actual = actual;
  }
}

export interface InspectCursorOptions {
  cursorFile: string;
}

export interface InspectCursorResult {
  exists: boolean;
  digest: string | null;
  version: number | null;
  targets: number;
}

export interface BackupCursorOptions {
  cursorFile: string;
  backupFile: string;
  force?: boolean;
  /** Optional CAS digest of the live cursor file from an earlier inspection. */
  expectedDigest?: string;
}

export interface BackupCursorResult {
  status: "backed_up";
  version: number;
  targets: number;
  digest: string;
}

export interface RestoreCursorOptions extends BackupCursorOptions {
  lockFile: string;
  /**
   * Optional CAS digest of the live cursor file (`null` requires the live
   * cursor file to be absent).
   */
  expectedLiveDigest?: string | null;
  /** Optional CAS digest of the backup source file from an earlier inspection. */
  expectedSourceDigest?: string;
  /** Test hook invoked after reading/validating and before the atomic write. */
  onBeforeWrite?: () => Promise<void> | void;
}

export interface RestoreCursorResult {
  status: "restored";
  version: number;
  targets: number;
  digest: string;
  previousDigest: string | null;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

function validateCursor(raw: string): ReturnType<typeof parseAndMigrateCursorFile> {
  try {
    return parseAndMigrateCursorFile(raw);
  } catch {
    throw new Error("cursor file is malformed or uses an unsupported schema");
  }
}

async function writeAtomic(filePath: string, contents: string, replace: boolean): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;

  try {
    await writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx" });
    if (replace) {
      await rename(temporaryPath, filePath);
    } else {
      try {
        await link(temporaryPath, filePath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error(`destination already exists at ${filePath}; pass --force to overwrite`);
        }
        throw err;
      }
    }
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function readOptionalFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Inspect a cursor file and return its schema metadata and CAS digest without exposing cursor values. */
export async function inspectCursor(options: InspectCursorOptions): Promise<InspectCursorResult> {
  const raw = await readOptionalFile(options.cursorFile);
  if (raw === null) {
    return { exists: false, digest: null, version: null, targets: 0 };
  }
  const parsed = validateCursor(raw);
  return {
    exists: true,
    digest: cursorDigest(raw),
    version: parsed.file.version,
    targets: Object.keys(parsed.file.targets).length,
  };
}

/** Copy a validated supported cursor snapshot without exposing cursor values. */
export async function backupCursor(options: BackupCursorOptions): Promise<BackupCursorResult> {
  const raw = await readFile(options.cursorFile, "utf8");
  const cas = checkCursorCas(raw, options.expectedDigest);
  if (!cas.ok) {
    throw new CursorConflictError("live", cas.expected, cas.actual, cas.reason);
  }
  const parsed = validateCursor(raw);
  if (!options.force && (await exists(options.backupFile))) {
    throw new Error(`backup already exists at ${options.backupFile}; pass --force to overwrite`);
  }
  await writeAtomic(options.backupFile, raw, options.force === true);
  const digest = cursorDigest(raw);
  const version = parsed.file.version;
  const targets = Object.keys(parsed.file.targets).length;
  console.log(
    `[cursor] backed up schema=v${version} targets=${targets} digest=${digest.slice(0, 12)} ` +
      `from ${options.cursorFile} to ${options.backupFile}`,
  );
  return { status: "backed_up", version, targets, digest };
}

/**
 * Restore a compatible cursor while holding the poller's exclusive lock and
 * enforcing compare-and-swap checks against both the live cursor and source
 * backup file so concurrent edits never silently overwrite a newer cursor.
 */
export async function restoreCursor(options: RestoreCursorOptions): Promise<RestoreCursorResult> {
  const initialSourceRaw = await readFile(options.backupFile, "utf8");
  const initialSourceDigest = cursorDigest(initialSourceRaw);
  const sourceCas = checkCursorCas(initialSourceRaw, options.expectedSourceDigest);
  if (!sourceCas.ok) {
    throw new CursorConflictError("source", sourceCas.expected, sourceCas.actual, sourceCas.reason);
  }
  const parsed = validateCursor(initialSourceRaw);

  const lock = await acquireInstanceLock(options.lockFile);
  try {
    const liveRawBefore = await readOptionalFile(options.cursorFile);
    const liveExpected =
      options.expectedLiveDigest !== undefined
        ? options.expectedLiveDigest
        : options.expectedDigest;
    const liveCasBefore = checkCursorCas(liveRawBefore, liveExpected);
    if (!liveCasBefore.ok) {
      throw new CursorConflictError(
        "live",
        liveCasBefore.expected,
        liveCasBefore.actual,
        liveCasBefore.reason,
      );
    }

    if (!options.force && liveRawBefore !== null) {
      throw new Error(`cursor already exists at ${options.cursorFile}; pass --force to replace it`);
    }

    if (options.onBeforeWrite) {
      await options.onBeforeWrite();
    }

    // Re-verify both the recovery source and live cursor right before writing
    // so any modification since inspection aborts and preserves the live cursor.
    const latestSourceRaw = await readOptionalFile(options.backupFile);
    const latestSourceCas = checkCursorCas(latestSourceRaw, initialSourceDigest);
    if (!latestSourceCas.ok) {
      throw new CursorConflictError(
        "source",
        latestSourceCas.expected,
        latestSourceCas.actual,
        latestSourceCas.reason,
      );
    }

    const liveDigestBefore = liveRawBefore === null ? null : cursorDigest(liveRawBefore);
    const liveRawNow = await readOptionalFile(options.cursorFile);
    const liveCasNow = checkCursorCas(liveRawNow, liveDigestBefore);
    if (!liveCasNow.ok) {
      throw new CursorConflictError(
        "live",
        liveCasNow.expected,
        liveCasNow.actual,
        liveCasNow.reason,
      );
    }

    const normalized = `${JSON.stringify(parsed.file, null, 2)}\n`;
    await writeAtomic(options.cursorFile, normalized, options.force === true);
    const digest = cursorDigest(normalized);
    const version = parsed.file.version;
    const targets = Object.keys(parsed.file.targets).length;
    console.log(
      `[cursor] restored schema=v${version} targets=${targets} digest=${digest.slice(0, 12)} ` +
        `from ${options.backupFile} to ${options.cursorFile}`,
    );
    return {
      status: "restored",
      version,
      targets,
      digest,
      previousDigest: liveDigestBefore,
    };
  } finally {
    await lock.release();
  }
}

interface CliOptions {
  file?: string;
  out?: string;
  from?: string;
  ifMatch?: string;
  expectedSourceDigest?: string;
  force: boolean;
  json: boolean;
}

function parseOptions(args: string[]): CliOptions {
  const options: CliOptions = { force: false, json: false };
  const seen = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--force") {
      if (seen.has(arg)) throw new Error("duplicate --force option");
      seen.add(arg);
      options.force = true;
      continue;
    }
    if (arg === "--json") {
      if (seen.has(arg)) throw new Error("duplicate --json option");
      seen.add(arg);
      options.json = true;
      continue;
    }
    if (
      arg !== "--file" &&
      arg !== "--out" &&
      arg !== "--from" &&
      arg !== "--if-match" &&
      arg !== "--expected-source-digest"
    ) {
      throw new Error(`unknown option: ${arg}`);
    }
    if (seen.has(arg)) throw new Error(`duplicate ${arg} option`);
    seen.add(arg);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    if (arg === "--file") options.file = value;
    else if (arg === "--out") options.out = value;
    else if (arg === "--from") options.from = value;
    else if (arg === "--if-match") options.ifMatch = value;
    else if (arg === "--expected-source-digest") options.expectedSourceDigest = value;
    index += 1;
  }

  return options;
}

function resolvePath(value: string): string {
  return path.resolve(process.cwd(), value);
}

function assertDifferentPaths(left: string, right: string): void {
  const normalize = (value: string) =>
    process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  if (normalize(left) === normalize(right)) {
    throw new Error("backup and live cursor paths must be different");
  }
}

export interface RunCursorCliOptions {
  argv?: string[];
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

export async function runCursorCli(options: RunCursorCliOptions = {}): Promise<{ exitCode: number }> {
  const argv = options.argv ?? process.argv.slice(2);
  const out = options.stdout ?? ((line: string) => console.log(line));
  const errOut = options.stderr ?? ((line: string) => console.error(line));

  const [action, ...args] = argv;
  if (action !== "inspect" && action !== "backup" && action !== "restore") {
    errOut(`[cursor] ${CURSOR_USAGE}`);
    return { exitCode: 1 };
  }

  let parsedOptions: CliOptions;
  try {
    parsedOptions = parseOptions(args);
  } catch (err) {
    const message = err instanceof Error ? err.message : "invalid options";
    errOut(`[cursor] ${message.replace(/\s+/g, " ").slice(0, 300)}`);
    return { exitCode: 1 };
  }

  const cursorFile = resolvePath(parsedOptions.file ?? process.env.CURSOR_FILE ?? "./data/cursor.json");

  try {
    if (action === "inspect") {
      const result = await inspectCursor({ cursorFile });
      if (parsedOptions.json) {
        out(JSON.stringify({ file: cursorFile, ...result }, null, 2));
      } else if (!result.exists) {
        out(`[cursor] absent at ${cursorFile}`);
      } else {
        out(
          `[cursor] schema=v${result.version} targets=${result.targets} digest=${result.digest} file=${cursorFile}`,
        );
      }
      return { exitCode: 0 };
    }

    if (action === "backup") {
      const backupFile = resolvePath(
        parsedOptions.out ?? `${cursorFile}.${new Date().toISOString().replace(/[:.]/g, "-")}.bak`,
      );
      assertDifferentPaths(cursorFile, backupFile);
      const result = await backupCursor({
        cursorFile,
        backupFile,
        force: parsedOptions.force,
        expectedDigest: parsedOptions.ifMatch,
      });
      if (parsedOptions.json) {
        out(JSON.stringify({ file: cursorFile, backupFile, ...result }, null, 2));
      }
      return { exitCode: 0 };
    }

    if (!parsedOptions.from) throw new Error("restore requires --from PATH");
    const backupFile = resolvePath(parsedOptions.from);
    assertDifferentPaths(cursorFile, backupFile);
    const lockFile = resolvePath(process.env.INSTANCE_LOCK_FILE ?? "./data/poller.lock");
    const expectedLiveDigest =
      parsedOptions.ifMatch === undefined
        ? undefined
        : parsedOptions.ifMatch === "absent"
          ? null
          : parsedOptions.ifMatch;
    const result = await restoreCursor({
      cursorFile,
      backupFile,
      lockFile,
      force: parsedOptions.force,
      expectedLiveDigest,
      expectedSourceDigest: parsedOptions.expectedSourceDigest,
    });
    if (parsedOptions.json) {
      out(JSON.stringify({ file: cursorFile, backupFile, ...result }, null, 2));
    }
    return { exitCode: 0 };
  } catch (err) {
    if (err instanceof CursorConflictError) {
      if (parsedOptions.json) {
        out(
          JSON.stringify(
            {
              status: "conflict",
              target: err.target,
              expected: err.expected,
              actual: err.actual,
              message: err.message,
            },
            null,
            2,
          ),
        );
      } else {
        errOut(`[cursor] ${err.message}`);
      }
      return { exitCode: 1 };
    }
    const message = err instanceof Error ? err.message : "cursor command failed";
    errOut(`[cursor] ${message.replace(/\s+/g, " ").slice(0, 300)}`);
    return { exitCode: 1 };
  }
}

async function main(): Promise<void> {
  loadDotenv({ path: process.env.DOTENV_CONFIG_PATH || ".env" });
  const { exitCode } = await runCursorCli();
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : "cursor command failed";
    console.error(`[cursor] ${message.replace(/\s+/g, " ").slice(0, 300)}`);
    process.exit(1);
  });
}
