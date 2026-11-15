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
  checkCursorArchiveConsistency,
  parseAndMigrateCursorFile,
  type CheckCursorArchiveOptions,
  type CursorArchiveConsistencyReport,
} from "./poller.js";

export type { CheckCursorArchiveOptions, CursorArchiveConsistencyReport };

export interface BackupCursorOptions {
  cursorFile: string;
  backupFile: string;
  force?: boolean;
}

export interface RestoreCursorOptions extends BackupCursorOptions {
  lockFile: string;
}

export interface CheckCursorOptions {
  cursorFile: string;
  archivePath: string;
  expectedContracts?: Partial<Record<string, string>>;
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

/**
 * Format a cursor-vs-archive consistency report for human operators without
 * exposing raw cursor tokens or remote event payloads.
 */
export function formatCursorConsistencyReport(report: CursorArchiveConsistencyReport): string {
  const lines: string[] = [];
  const verdict = report.consistent ? "CONSISTENT" : "INCONSISTENT";
  lines.push(
    `[cursor] consistency=${verdict} files=${report.archiveFilesScanned} ` +
      `events=${report.archiveEventsScanned} gaps=${report.gaps.length} ` +
      `contradictions=${report.contradictions.length}`,
  );
  for (const target of report.targets) {
    const cursorPos = target.cursorOpaque
      ? "opaque"
      : target.cursorLedger !== null
        ? String(target.cursorLedger)
        : "none";
    const archiveRange =
      target.archiveWindowStart !== null && target.archiveWindowEnd !== null
        ? `${target.archiveWindowStart}..${target.archiveWindowEnd}`
        : "none";
    const contracts =
      target.archiveContractIds.length > 0 ? target.archiveContractIds.join(",") : "none";
    lines.push(
      `  target=${target.target} status=${target.status} cursorLedger=${cursorPos} ` +
        `lastEventLedger=${target.lastEventLedger ?? "none"} ` +
        `archiveEvents=${target.archiveEventCount} archiveRange=${archiveRange} ` +
        `archiveContracts=${contracts}`,
    );
  }
  for (const issue of report.issues) {
    const scope = issue.target ? ` target=${issue.target}` : "";
    lines.push(`  [${issue.severity.toUpperCase()}] code=${issue.code}${scope}: ${issue.message}`);
  }
  return lines.join("\n");
}

/**
 * Perform a strictly read-only cursor consistency check against scan archives.
 * Never locks, writes, or advances the cursor file.
 */
export async function checkCursorConsistency(
  options: CheckCursorOptions,
): Promise<CursorArchiveConsistencyReport> {
  const raw = await readFile(options.cursorFile, "utf8");
  validateCursor(raw);
  return checkCursorArchiveConsistency(options);
}

interface CliOptions {
  file?: string;
  out?: string;
  from?: string;
  archive?: string;
  marketContract?: string;
  squadContract?: string;
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
      arg !== "--archive" &&
      arg !== "--market-contract" &&
      arg !== "--squad-contract"
    ) {
      throw new Error(`unknown option: ${arg}`);
    }
    if (seen.has(arg)) throw new Error(`duplicate ${arg} option`);
    seen.add(arg);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      const noun = arg.endsWith("-contract") ? "a contract id" : "a path";
      throw new Error(`${arg} requires ${noun}`);
    }
    if (arg === "--market-contract") {
      options.marketContract = value;
    } else if (arg === "--squad-contract") {
      options.squadContract = value;
    } else {
      options[arg.slice(2) as "file" | "out" | "from" | "archive"] = value;
    }
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

async function main(): Promise<void> {
  loadDotenv({ path: process.env.DOTENV_CONFIG_PATH || ".env" });
  const [action, ...args] = process.argv.slice(2);
  if (action !== "backup" && action !== "restore" && action !== "check") {
    throw new Error(
      "usage: npm run cursor -- <backup|restore|check> [--file PATH] [--out PATH|--from PATH|--archive PATH] [--force] [--json]",
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

  if (action === "check") {
    const archiveRaw = options.archive ?? process.env.EVENT_ARCHIVE_DIR;
    if (!archiveRaw) throw new Error("check requires --archive PATH");
    const archivePath = resolvePath(archiveRaw);
    const expectedContracts: Partial<Record<string, string>> = {};
    const marketContract = options.marketContract ?? process.env.MARKET_CONTRACT_ID;
    const squadContract = options.squadContract ?? process.env.SQUAD_CONTRACT_ID;
    if (marketContract && marketContract.trim().length > 0) {
      expectedContracts.market = marketContract.trim();
    }
    if (squadContract && squadContract.trim().length > 0) {
      expectedContracts.squad = squadContract.trim();
    }
    const report = await checkCursorConsistency({
      cursorFile,
      archivePath,
      expectedContracts,
    });
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatCursorConsistencyReport(report));
    }
    if (!report.consistent) {
      process.exitCode = 1;
    }
    return;
  }

  if (!options.from) throw new Error("restore requires --from PATH");
  const backupFile = resolvePath(options.from);
  assertDifferentPaths(cursorFile, backupFile);
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
