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
import {
  classifyPreviewCursorPosition,
  type CursorRecoveryPreview,
  evaluateCursorRecoveryPreview,
  formatCursorRecoveryPreview,
  type LedgerRangeEstimate,
  parseAndMigrateCursorFile,
  type PreviewCursorPosition,
  type RetainedWindowEvidence,
  type TargetRecoveryPreview,
  type TargetWindowPlacement,
} from "./poller.js";

export {
  classifyPreviewCursorPosition,
  type CursorRecoveryPreview,
  evaluateCursorRecoveryPreview,
  formatCursorRecoveryPreview,
  type LedgerRangeEstimate,
  type PreviewCursorPosition,
  type RetainedWindowEvidence,
  type TargetRecoveryPreview,
  type TargetWindowPlacement,
};

export interface BackupCursorOptions {
  cursorFile: string;
  backupFile: string;
  force?: boolean;
}

export interface RestoreCursorOptions extends BackupCursorOptions {
  lockFile: string;
}

export interface PreviewCursorOptions {
  cursorFile: string;
  backupFile: string;
  statusFile?: string;
  retainedWindow?: {
    oldestLedger: number;
    latestLedger?: number | null;
    capturedAt?: string | null;
  };
  now?: () => Date;
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

/** Copy a validated supported cursor snapshot without exposing cursor values. */
export async function backupCursor(options: BackupCursorOptions): Promise<void> {
  const raw = await readFile(options.cursorFile, "utf8");
  const parsed = validateCursor(raw);
  if (!options.force && (await exists(options.backupFile))) {
    throw new Error(`backup already exists at ${options.backupFile}; pass --force to overwrite`);
  }
  await writeAtomic(options.backupFile, raw, options.force === true);
  console.log(
    `[cursor] backed up schema=v` + `${parsed.file.version} targets=${Object.keys(parsed.file.targets).length} ` +
      `from ${options.cursorFile} to ${options.backupFile}`,
  );
}

/** Restore a compatible cursor while holding the poller's exclusive lock. */
export async function restoreCursor(options: RestoreCursorOptions): Promise<void> {
  const lock = await acquireInstanceLock(options.lockFile);
  try {
    const raw = await readFile(options.backupFile, "utf8");
    const parsed = validateCursor(raw);
    if (!options.force && (await exists(options.cursorFile))) {
      throw new Error(`cursor already exists at ${options.cursorFile}; pass --force to replace it`);
    }
    const normalized = `${JSON.stringify(parsed.file, null, 2)}\n`;
    await writeAtomic(options.cursorFile, normalized, options.force === true);
    console.log(
      `[cursor] restored schema=v${parsed.file.version} targets=${Object.keys(parsed.file.targets).length} ` +
        `from ${options.backupFile} to ${options.cursorFile}`,
    );
  } finally {
    await lock.release();
  }
}

async function loadStatusWindowEvidence(
  statusFile: string | undefined,
): Promise<Partial<RetainedWindowEvidence> | null> {
  if (!statusFile) return null;
  try {
    const raw = await readFile(statusFile, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    if (
      typeof obj.oldestLedger !== "number" ||
      !Number.isSafeInteger(obj.oldestLedger) ||
      obj.oldestLedger <= 0
    ) {
      return null;
    }
    const latestLedger =
      typeof obj.latestLedger === "number" &&
      Number.isSafeInteger(obj.latestLedger) &&
      obj.latestLedger >= obj.oldestLedger
        ? obj.latestLedger
        : null;
    const capturedAt = typeof obj.generatedAt === "string" ? obj.generatedAt : null;
    return {
      source: "status_file",
      oldestLedger: obj.oldestLedger,
      latestLedger,
      capturedAt,
    };
  } catch {
    return null;
  }
}

/**
 * Preview restoring `backupFile` over `cursorFile` without touching disk or
 * submitting any network or chain requests.
 */
export async function previewCursorRecovery(
  options: PreviewCursorOptions,
): Promise<CursorRecoveryPreview> {
  const nowFn = options.now ?? (() => new Date());
  const rawBackup = await readFile(options.backupFile, "utf8");
  const proposed = validateCursor(rawBackup);

  let liveState: "valid" | "missing" | "unreadable" = "missing";
  let liveTargets:
    | Record<
        string,
        {
          cursor?: string | null;
          lastEventLedger?: number | null;
          rewindFromLedger?: number | null;
        }
      >
    | undefined;

  if (await exists(options.cursorFile)) {
    try {
      const rawLive = await readFile(options.cursorFile, "utf8");
      const parsedLive = parseAndMigrateCursorFile(rawLive, { now: nowFn });
      liveState = "valid";
      liveTargets = parsedLive.file.targets;
    } catch {
      liveState = "unreadable";
    }
  }

  let windowEvidence: Partial<RetainedWindowEvidence> | null = null;
  if (options.retainedWindow !== undefined) {
    windowEvidence = {
      source: "explicit",
      oldestLedger: options.retainedWindow.oldestLedger,
      latestLedger: options.retainedWindow.latestLedger ?? null,
      capturedAt: options.retainedWindow.capturedAt ?? null,
    };
  } else {
    windowEvidence = await loadStatusWindowEvidence(options.statusFile);
  }

  return evaluateCursorRecoveryPreview({
    cursorFile: options.cursorFile,
    backupFile: options.backupFile,
    liveState,
    liveTargets,
    proposedFile: proposed.file,
    proposedSchemaSource: proposed.source,
    windowEvidence,
  });
}

interface CliOptions {
  file?: string;
  out?: string;
  from?: string;
  statusFile?: string;
  oldestLedger?: number;
  latestLedger?: number;
  force: boolean;
  dryRun: boolean;
  json: boolean;
}

function parsePositiveIntegerFlag(flag: string, value: string | undefined): number {
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a positive integer`);
  }
  if (!/^\d+$/.test(value)) {
    throw new Error(`${flag} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive safe integer`);
  }
  return parsed;
}

function parseOptions(args: string[]): CliOptions {
  const options: CliOptions = { force: false, dryRun: false, json: false };
  const seen = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--force" || arg === "--dry-run" || arg === "--json") {
      if (seen.has(arg)) throw new Error(`duplicate ${arg} option`);
      seen.add(arg);
      if (arg === "--force") options.force = true;
      if (arg === "--dry-run") options.dryRun = true;
      if (arg === "--json") options.json = true;
      continue;
    }
    if (arg === "--oldest-ledger" || arg === "--latest-ledger") {
      if (seen.has(arg)) throw new Error(`duplicate ${arg} option`);
      seen.add(arg);
      const parsed = parsePositiveIntegerFlag(arg, args[index + 1]);
      if (arg === "--oldest-ledger") options.oldestLedger = parsed;
      else options.latestLedger = parsed;
      index += 1;
      continue;
    }
    if (arg !== "--file" && arg !== "--out" && arg !== "--from" && arg !== "--status-file") {
      throw new Error(`unknown option: ${arg}`);
    }
    if (seen.has(arg)) throw new Error(`duplicate ${arg} option`);
    seen.add(arg);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a path`);
    if (arg === "--status-file") options.statusFile = value;
    else options[arg.slice(2) as "file" | "out" | "from"] = value;
    index += 1;
  }

  if (
    options.latestLedger !== undefined &&
    options.oldestLedger !== undefined &&
    options.latestLedger < options.oldestLedger
  ) {
    throw new Error("--latest-ledger must be greater than or equal to --oldest-ledger");
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

async function main(): Promise<void> {
  loadDotenv({ path: process.env.DOTENV_CONFIG_PATH || ".env" });
  const [action, ...args] = process.argv.slice(2);
  if (action !== "backup" && action !== "restore" && action !== "preview") {
    throw new Error(
      "usage: npm run cursor -- <backup|restore|preview> [--file PATH] [--out PATH|--from PATH] " +
        "[--status-file PATH] [--oldest-ledger N] [--latest-ledger N] [--dry-run] [--json] [--force]",
    );
  }

  const options = parseOptions(args);
  const cursorFile = resolvePath(options.file ?? process.env.CURSOR_FILE ?? "./data/cursor.json");
  if (action === "backup") {
    const backupFile = resolvePath(
      options.out ?? `${cursorFile}.${new Date().toISOString().replace(/[:.]/g, "-")}.bak`,
    );
    assertDifferentPaths(cursorFile, backupFile);
    await backupCursor({ cursorFile, backupFile, force: options.force });
    return;
  }

  if (!options.from) throw new Error(`${action} requires --from PATH`);
  const backupFile = resolvePath(options.from);
  assertDifferentPaths(cursorFile, backupFile);

  if (action === "preview" || options.dryRun) {
    const defaultStatusPath = resolvePath(
      options.statusFile ?? process.env.STATUS_FILE ?? "./data/status.json",
    );
    const preview = await previewCursorRecovery({
      cursorFile,
      backupFile,
      statusFile: defaultStatusPath,
      retainedWindow:
        options.oldestLedger !== undefined
          ? { oldestLedger: options.oldestLedger, latestLedger: options.latestLedger ?? null }
          : undefined,
    });
    if (options.json) {
      console.log(JSON.stringify(preview, null, 2));
    } else {
      console.log(formatCursorRecoveryPreview(preview));
    }
    return;
  }

  const lockFile = resolvePath(process.env.INSTANCE_LOCK_FILE ?? "./data/poller.lock");
  await restoreCursor({
    cursorFile,
    backupFile,
    lockFile,
    force: options.force,
  });
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : "cursor command failed";
    console.error(`[cursor] ${message.replace(/\s+/g, " ").slice(0, 300)}`);
    process.exit(1);
  });
}
