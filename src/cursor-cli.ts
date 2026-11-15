/*
 * Offline cursor inspection, backup, and restore command with compare-and-swap
 * (CAS) protection. It never contacts Stellar or Telegram; restore uses the
 * normal instance lock to exclude a running poller and refuses writes if the
 * source (or pinned live cursor) changed since inspection.
 */

import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { pathToFileURL } from "node:url";

import { acquireInstanceLock } from "./instanceLock.js";
import {
  computeCursorDigest,
  CURSOR_CAS_MISSING_SENTINEL,
  type CursorCasAppliedResult,
  type CursorCasCommand,
  CursorCasConflictError,
  type CursorCasConflictReason,
  type CursorCasConflictResult,
  type CursorCasInspection,
  type CursorCasResult,
  type CursorCasTargetSummary,
  evaluateCursorCas,
  formatCursorCasConflict,
  parseAndMigrateCursorFile,
  parseExpectedCursorDigest,
  readCursorFileSnapshot,
  summarizeCursorTargets,
} from "./poller.js";

export {
  computeCursorDigest,
  CURSOR_CAS_MISSING_SENTINEL,
  type CursorCasAppliedResult,
  type CursorCasCommand,
  CursorCasConflictError,
  type CursorCasConflictReason,
  type CursorCasConflictResult,
  type CursorCasInspection,
  type CursorCasResult,
  type CursorCasTargetSummary,
  evaluateCursorCas,
  formatCursorCasConflict,
  parseExpectedCursorDigest,
  readCursorFileSnapshot,
  summarizeCursorTargets,
};

export interface CursorCasHookSnapshot {
  sourceFile: string;
  destinationFile: string;
  sourceDigest: string;
  destinationDigest: string | null;
}

export interface InspectCursorRecoveryOptions {
  action?: CursorCasCommand;
  cursorFile: string;
  backupFile: string;
  now?: () => Date;
}

export interface BackupCursorOptions {
  cursorFile: string;
  backupFile: string;
  force?: boolean;
  lockFile?: string | undefined;
  inspected?: CursorCasInspection | undefined;
  expectedSourceDigest?: string | undefined;
  expectedDestinationDigest?: string | null | undefined;
  checkDestinationDigest?: boolean | undefined;
  quiet?: boolean | undefined;
  onAfterInspect?: ((snapshot: CursorCasHookSnapshot) => Promise<void> | void) | undefined;
}

export interface RestoreCursorOptions {
  cursorFile: string;
  backupFile: string;
  lockFile: string;
  force?: boolean;
  inspected?: CursorCasInspection | undefined;
  expectedSourceDigest?: string | undefined;
  expectedLiveDigest?: string | null | undefined;
  checkLiveDigest?: boolean | undefined;
  quiet?: boolean | undefined;
  onAfterInspect?: ((snapshot: CursorCasHookSnapshot) => Promise<void> | void) | undefined;
}

function validateCursor(raw: string): ReturnType<typeof parseAndMigrateCursorFile> {
  try {
    return parseAndMigrateCursorFile(raw);
  } catch {
    throw new Error("cursor file is malformed or uses an unsupported schema");
  }
}

function normalizeComparePath(value: string): string {
  return process.platform === "win32"
    ? path.resolve(value).toLowerCase()
    : path.resolve(value);
}

function assertDifferentPaths(left: string, right: string): void {
  if (normalizeComparePath(left) === normalizeComparePath(right)) {
    throw new Error("backup and live cursor paths must be different");
  }
}

function assertMatchingInspectionPaths(
  inspected: CursorCasInspection,
  expectedAction: CursorCasCommand,
  sourceFile: string,
  destinationFile: string,
): void {
  if (inspected.action !== expectedAction) {
    throw new Error(
      `inspection snapshot is for "${inspected.action}" and cannot authorize "${expectedAction}"`,
    );
  }
  if (
    normalizeComparePath(inspected.sourceFile) !== normalizeComparePath(sourceFile) ||
    normalizeComparePath(inspected.destinationFile) !== normalizeComparePath(destinationFile)
  ) {
    throw new Error("inspection snapshot paths do not match recovery source/destination paths");
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

/**
 * Inspect a recovery source and destination without mutating disk or exposing
 * opaque cursor values. Returns SHA-256 digests suitable for CAS-guarded
 * `restoreCursor` or `backupCursor` execution.
 */
export async function inspectCursorRecovery(
  options: InspectCursorRecoveryOptions,
): Promise<CursorCasInspection> {
  const action: CursorCasCommand = options.action ?? "restore";
  assertDifferentPaths(options.cursorFile, options.backupFile);

  const sourceFile = action === "restore" ? options.backupFile : options.cursorFile;
  const destinationFile = action === "restore" ? options.cursorFile : options.backupFile;

  const source = await readCursorFileSnapshot(sourceFile);
  if (source === null) {
    await readFile(sourceFile, "utf8");
    throw new Error(`source cursor file not found: ${sourceFile}`);
  }
  const parsed = validateCursor(source.raw);
  const destination = await readCursorFileSnapshot(destinationFile);
  const nowFn = options.now ?? (() => new Date());

  return {
    action,
    sourceFile,
    destinationFile,
    sourceDigest: source.digest,
    destinationDigest: destination?.digest ?? null,
    destinationExists: destination !== null,
    schemaVersion: parsed.file.version,
    schemaSource: parsed.source,
    targets: summarizeCursorTargets(parsed.file),
    inspectedAt: nowFn().toISOString(),
  };
}

/**
 * Copy a validated supported cursor snapshot without exposing cursor values.
 * Enforces compare-and-swap protection if the source (or pinned destination)
 * changed since inspection.
 */
export async function backupCursor(options: BackupCursorOptions): Promise<CursorCasAppliedResult> {
  if (options.inspected !== undefined) {
    assertMatchingInspectionPaths(
      options.inspected,
      "backup",
      options.cursorFile,
      options.backupFile,
    );
  }

  const explicitExpectedSource =
    options.expectedSourceDigest !== undefined
      ? parseExpectedCursorDigest(options.expectedSourceDigest, { label: "expectedSourceDigest" })!
      : options.inspected !== undefined
        ? parseExpectedCursorDigest(options.inspected.sourceDigest, {
            label: "inspected.sourceDigest",
          })!
        : undefined;

  let checkDestination = false;
  let expectedDestination: string | null = null;
  if (options.expectedDestinationDigest !== undefined) {
    checkDestination = options.checkDestinationDigest ?? true;
    expectedDestination =
      options.expectedDestinationDigest === null
        ? null
        : parseExpectedCursorDigest(options.expectedDestinationDigest, {
            allowMissing: true,
            label: "expectedDestinationDigest",
          });
  } else if (options.inspected !== undefined) {
    checkDestination = options.checkDestinationDigest ?? true;
    expectedDestination =
      options.inspected.destinationDigest === null
        ? null
        : parseExpectedCursorDigest(options.inspected.destinationDigest, {
            label: "inspected.destinationDigest",
          });
  }

  const preSource = await readCursorFileSnapshot(options.cursorFile);
  if (explicitExpectedSource === undefined) {
    if (preSource === null) {
      await readFile(options.cursorFile, "utf8");
      throw new Error(`cursor file not found: ${options.cursorFile}`);
    }
    validateCursor(preSource.raw);
  }

  const effectiveExpectedSource = explicitExpectedSource ?? preSource!.digest;

  if (options.onAfterInspect) {
    const preDestination = await readCursorFileSnapshot(options.backupFile);
    await options.onAfterInspect({
      sourceFile: options.cursorFile,
      destinationFile: options.backupFile,
      sourceDigest: preSource?.digest ?? effectiveExpectedSource,
      destinationDigest: preDestination?.digest ?? null,
    });
  }

  const lock = options.lockFile ? await acquireInstanceLock(options.lockFile) : null;
  try {
    const verifiedSource = await readCursorFileSnapshot(options.cursorFile);
    const verifiedDestination = await readCursorFileSnapshot(options.backupFile);

    const conflict = evaluateCursorCas({
      command: "backup",
      sourceFile: options.cursorFile,
      destinationFile: options.backupFile,
      expectedSourceDigest: effectiveExpectedSource,
      actualSourceDigest: verifiedSource?.digest ?? null,
      checkDestinationDigest: checkDestination,
      expectedDestinationDigest: expectedDestination,
      actualDestinationDigest: verifiedDestination?.digest ?? null,
    });
    if (conflict !== null) {
      if (!options.quiet) console.error(formatCursorCasConflict(conflict));
      throw new CursorCasConflictError(conflict);
    }

    const parsed = validateCursor(verifiedSource!.raw);
    if (!options.force && verifiedDestination !== null) {
      throw new Error(`backup already exists at ${options.backupFile}; pass --force to overwrite`);
    }

    await writeAtomic(options.backupFile, verifiedSource!.raw, options.force === true);
    if (!options.quiet) {
      console.log(
        `[cursor] backed up schema=v` +
          `${parsed.file.version} targets=${Object.keys(parsed.file.targets).length} ` +
          `from ${options.cursorFile} to ${options.backupFile}`,
      );
    }

    return {
      status: "applied",
      command: "backup",
      sourceFile: options.cursorFile,
      destinationFile: options.backupFile,
      sourceDigest: verifiedSource!.digest,
      previousDestinationDigest: verifiedDestination?.digest ?? null,
      newDestinationDigest: verifiedSource!.digest,
      schemaVersion: parsed.file.version,
      targetCount: Object.keys(parsed.file.targets).length,
    };
  } finally {
    if (lock) await lock.release();
  }
}

/**
 * Restore a compatible cursor while holding the poller's exclusive lock.
 * Enforces compare-and-swap protection so any source mutation (or pinned live
 * cursor mutation) since inspection refuses the recovery write and preserves
 * the current live cursor untouched.
 */
export async function restoreCursor(options: RestoreCursorOptions): Promise<CursorCasAppliedResult> {
  if (options.inspected !== undefined) {
    assertMatchingInspectionPaths(
      options.inspected,
      "restore",
      options.backupFile,
      options.cursorFile,
    );
  }

  const explicitExpectedSource =
    options.expectedSourceDigest !== undefined
      ? parseExpectedCursorDigest(options.expectedSourceDigest, { label: "expectedSourceDigest" })!
      : options.inspected !== undefined
        ? parseExpectedCursorDigest(options.inspected.sourceDigest, {
            label: "inspected.sourceDigest",
          })!
        : undefined;

  let checkLive = false;
  let expectedLive: string | null = null;
  if (options.expectedLiveDigest !== undefined) {
    checkLive = options.checkLiveDigest ?? true;
    expectedLive =
      options.expectedLiveDigest === null
        ? null
        : parseExpectedCursorDigest(options.expectedLiveDigest, {
            allowMissing: true,
            label: "expectedLiveDigest",
          });
  } else if (options.inspected !== undefined) {
    checkLive = options.checkLiveDigest ?? true;
    expectedLive =
      options.inspected.destinationDigest === null
        ? null
        : parseExpectedCursorDigest(options.inspected.destinationDigest, {
            label: "inspected.destinationDigest",
          });
  }

  const preSource = await readCursorFileSnapshot(options.backupFile);
  if (explicitExpectedSource === undefined) {
    if (preSource === null) {
      await readFile(options.backupFile, "utf8");
      throw new Error(`backup cursor file not found: ${options.backupFile}`);
    }
    validateCursor(preSource.raw);
  }

  const effectiveExpectedSource = explicitExpectedSource ?? preSource!.digest;

  if (options.onAfterInspect) {
    const preLive = await readCursorFileSnapshot(options.cursorFile);
    await options.onAfterInspect({
      sourceFile: options.backupFile,
      destinationFile: options.cursorFile,
      sourceDigest: preSource?.digest ?? effectiveExpectedSource,
      destinationDigest: preLive?.digest ?? null,
    });
  }

  const lock = await acquireInstanceLock(options.lockFile);
  try {
    const lockedSource = await readCursorFileSnapshot(options.backupFile);
    const lockedLive = await readCursorFileSnapshot(options.cursorFile);

    const conflict = evaluateCursorCas({
      command: "restore",
      sourceFile: options.backupFile,
      destinationFile: options.cursorFile,
      expectedSourceDigest: effectiveExpectedSource,
      actualSourceDigest: lockedSource?.digest ?? null,
      checkDestinationDigest: checkLive,
      expectedDestinationDigest: expectedLive,
      actualDestinationDigest: lockedLive?.digest ?? null,
    });
    if (conflict !== null) {
      if (!options.quiet) console.error(formatCursorCasConflict(conflict));
      throw new CursorCasConflictError(conflict);
    }

    const parsed = validateCursor(lockedSource!.raw);
    if (!options.force && lockedLive !== null) {
      throw new Error(`cursor already exists at ${options.cursorFile}; pass --force to replace it`);
    }

    const normalized = `${JSON.stringify(parsed.file, null, 2)}\n`;
    await writeAtomic(options.cursorFile, normalized, options.force === true);
    if (!options.quiet) {
      console.log(
        `[cursor] restored schema=v${parsed.file.version} targets=${Object.keys(parsed.file.targets).length} ` +
          `from ${options.backupFile} to ${options.cursorFile}`,
      );
    }

    return {
      status: "applied",
      command: "restore",
      sourceFile: options.backupFile,
      destinationFile: options.cursorFile,
      sourceDigest: lockedSource!.digest,
      previousDestinationDigest: lockedLive?.digest ?? null,
      newDestinationDigest: computeCursorDigest(normalized),
      schemaVersion: parsed.file.version,
      targetCount: Object.keys(parsed.file.targets).length,
    };
  } finally {
    await lock.release();
  }
}

/**
 * Non-throwing CAS wrapper around {@link restoreCursor}: returns a discriminated
 * `CursorCasResult` (`status: "applied"` or `status: "conflict"`) while still
 * propagating lock, I/O, or validation errors.
 */
export async function tryRestoreCursor(options: RestoreCursorOptions): Promise<CursorCasResult> {
  try {
    return await restoreCursor(options);
  } catch (err) {
    if (err instanceof CursorCasConflictError) {
      return err.conflict;
    }
    throw err;
  }
}

/**
 * Non-throwing CAS wrapper around {@link backupCursor}: returns a discriminated
 * `CursorCasResult` (`status: "applied"` or `status: "conflict"`) while still
 * propagating lock, I/O, or validation errors.
 */
export async function tryBackupCursor(options: BackupCursorOptions): Promise<CursorCasResult> {
  try {
    return await backupCursor(options);
  } catch (err) {
    if (err instanceof CursorCasConflictError) {
      return err.conflict;
    }
    throw err;
  }
}

interface CliOptions {
  file?: string;
  out?: string;
  from?: string;
  expectedSourceDigest?: string;
  expectedLiveDigest?: string;
  expectedDestinationDigest?: string;
  force: boolean;
  json: boolean;
}

function parseOptions(args: string[]): CliOptions {
  const options: CliOptions = { force: false, json: false };
  const seen = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--force" || arg === "--json") {
      if (seen.has(arg)) throw new Error(`duplicate ${arg} option`);
      seen.add(arg);
      if (arg === "--force") options.force = true;
      if (arg === "--json") options.json = true;
      continue;
    }
    if (
      arg !== "--file" &&
      arg !== "--out" &&
      arg !== "--from" &&
      arg !== "--expected-source-digest" &&
      arg !== "--expected-live-digest" &&
      arg !== "--expected-destination-digest"
    ) {
      throw new Error(`unknown option: ${arg}`);
    }
    if (seen.has(arg)) throw new Error(`duplicate ${arg} option`);
    seen.add(arg);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${arg} requires a value`);
    }
    if (arg === "--expected-source-digest") options.expectedSourceDigest = value;
    else if (arg === "--expected-live-digest") options.expectedLiveDigest = value;
    else if (arg === "--expected-destination-digest") options.expectedDestinationDigest = value;
    else options[arg.slice(2) as "file" | "out" | "from"] = value;
    index += 1;
  }

  return options;
}

function resolvePath(value: string): string {
  return path.resolve(process.cwd(), value);
}

async function main(): Promise<void> {
  loadDotenv({ path: process.env.DOTENV_CONFIG_PATH || ".env" });
  const [action, ...args] = process.argv.slice(2);
  if (action !== "backup" && action !== "restore" && action !== "inspect") {
    throw new Error(
      "usage: npm run cursor -- <inspect|backup|restore> [--file PATH] [--out PATH|--from PATH] " +
        "[--expected-source-digest SHA256] [--expected-live-digest SHA256|missing] " +
        "[--expected-destination-digest SHA256|missing] [--json] [--force]",
    );
  }

  const options = parseOptions(args);
  const cursorFile = resolvePath(options.file ?? process.env.CURSOR_FILE ?? "./data/cursor.json");

  if (action === "inspect") {
    if (options.from && options.out) {
      throw new Error(
        "inspect accepts either --from PATH (for restore) or --out PATH (for backup), not both",
      );
    }
    if (!options.from && !options.out) {
      throw new Error("inspect requires --from PATH (for restore) or --out PATH (for backup)");
    }
    const inspectAction: CursorCasCommand = options.from ? "restore" : "backup";
    const backupFile = resolvePath((options.from ?? options.out)!);
    assertDifferentPaths(cursorFile, backupFile);

    const inspection = await inspectCursorRecovery({
      action: inspectAction,
      cursorFile,
      backupFile,
    });
    if (options.json) {
      console.log(JSON.stringify(inspection, null, 2));
    } else {
      console.log(
        `[cursor] inspected action=${inspection.action} schema=v${inspection.schemaVersion} ` +
          `targets=${inspection.targets.length} source=${inspection.sourceFile} ` +
          `source_digest=${inspection.sourceDigest} destination=${inspection.destinationFile} ` +
          `destination_digest=${inspection.destinationDigest ?? CURSOR_CAS_MISSING_SENTINEL}`,
      );
    }
    return;
  }

  if (action === "backup") {
    const backupFile = resolvePath(
      options.out ?? `${cursorFile}.${new Date().toISOString().replace(/[:.]/g, "-")}.bak`,
    );
    assertDifferentPaths(cursorFile, backupFile);
    const result = await backupCursor({
      cursorFile,
      backupFile,
      force: options.force,
      expectedSourceDigest: options.expectedSourceDigest,
      expectedDestinationDigest:
        options.expectedDestinationDigest ?? options.expectedLiveDigest,
      quiet: true,
    });
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(
        `[cursor] backed up schema=v${result.schemaVersion} targets=${result.targetCount} ` +
          `from ${cursorFile} to ${backupFile}`,
      );
    }
    return;
  }

  if (!options.from) throw new Error("restore requires --from PATH");
  const backupFile = resolvePath(options.from);
  assertDifferentPaths(cursorFile, backupFile);
  const lockFile = resolvePath(process.env.INSTANCE_LOCK_FILE ?? "./data/poller.lock");
  const result = await restoreCursor({
    cursorFile,
    backupFile,
    lockFile,
    force: options.force,
    expectedSourceDigest: options.expectedSourceDigest,
    expectedLiveDigest: options.expectedLiveDigest ?? options.expectedDestinationDigest,
    quiet: true,
  });
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      `[cursor] restored schema=v${result.schemaVersion} targets=${result.targetCount} ` +
        `from ${backupFile} to ${cursorFile}`,
    );
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  const jsonRequested = process.argv.slice(2).includes("--json");
  main().catch((err: unknown) => {
    if (err instanceof CursorCasConflictError) {
      if (jsonRequested) {
        console.log(JSON.stringify(err.conflict, null, 2));
      }
      console.error(formatCursorCasConflict(err.conflict));
      process.exit(2);
    }
    const message = err instanceof Error ? err.message : "cursor command failed";
    console.error(`[cursor] ${message.replace(/\s+/g, " ").slice(0, 300)}`);
    process.exit(1);
  });
}
