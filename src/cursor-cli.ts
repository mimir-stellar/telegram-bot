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
  classifyCursorFsError,
  parseAndMigrateCursorFile,
  type CursorDiagnosticCode,
} from "./poller.js";

export class CursorDiagnosticError extends Error {
  readonly code: CursorDiagnosticCode;
  readonly errno?: string | undefined;

  constructor(code: CursorDiagnosticCode, message: string, errno?: string) {
    super(`[${code}] ${message}`);
    this.name = "CursorDiagnosticError";
    this.code = code;
    this.errno = errno;
  }
}

function toCursorFsDiagnostic(err: unknown, targetPath: string, operation: string): CursorDiagnosticError {
  if (err instanceof CursorDiagnosticError) return err;
  const classified = classifyCursorFsError(err);
  const errnoSuffix = classified.errnoCode ? ` (${classified.errnoCode})` : "";
  if (classified.kind === "not_found") {
    return new CursorDiagnosticError(
      "CURSOR_NOT_FOUND",
      `cursor file not found while ${operation} "${targetPath}"`,
      classified.errnoCode,
    );
  }
  if (classified.kind === "permission") {
    return new CursorDiagnosticError(
      "CURSOR_PERMISSION_DENIED",
      `cursor directory or file permission failure while ${operation} "${targetPath}"${errnoSuffix}; existing files were preserved`,
      classified.errnoCode,
    );
  }
  return new CursorDiagnosticError(
    "CURSOR_IO_ERROR",
    `operational I/O failure while ${operation} "${targetPath}"${errnoSuffix}; existing files were preserved`,
    classified.errnoCode,
  );
}

export interface BackupCursorOptions {
  cursorFile: string;
  backupFile: string;
  force?: boolean;
}

export interface RestoreCursorOptions extends BackupCursorOptions {
  lockFile: string;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (err) {
    const classified = classifyCursorFsError(err);
    if (classified.kind === "not_found") return false;
    throw toCursorFsDiagnostic(err, filePath, "checking");
  }
}

function validateCursor(raw: string, filePath: string): ReturnType<typeof parseAndMigrateCursorFile> {
  try {
    return parseAndMigrateCursorFile(raw);
  } catch {
    throw new CursorDiagnosticError(
      "CURSOR_CORRUPT_JSON",
      `cursor file at "${filePath}" is malformed JSON or uses an unsupported schema`,
    );
  }
}

async function readCursorText(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (err) {
    throw toCursorFsDiagnostic(err, filePath, "reading");
  }
}

async function writeAtomic(filePath: string, contents: string, replace: boolean): Promise<void> {
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
  } catch (err) {
    throw toCursorFsDiagnostic(err, path.dirname(filePath), "preparing directory for");
  }
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
        throw toCursorFsDiagnostic(err, filePath, "writing");
      }
    }
  } catch (err) {
    if (err instanceof CursorDiagnosticError) throw err;
    if (err instanceof Error && err.message.includes("destination already exists")) throw err;
    throw toCursorFsDiagnostic(err, filePath, "writing");
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

/** Copy a validated supported cursor snapshot without exposing cursor values. */
export async function backupCursor(options: BackupCursorOptions): Promise<void> {
  const raw = await readCursorText(options.cursorFile);
  const parsed = validateCursor(raw, options.cursorFile);
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
  let lock: Awaited<ReturnType<typeof acquireInstanceLock>>;
  try {
    lock = await acquireInstanceLock(options.lockFile);
  } catch (err) {
    const classified = classifyCursorFsError(err);
    if (classified.kind === "permission" || classified.kind === "io") {
      throw toCursorFsDiagnostic(err, options.lockFile, "acquiring lock at");
    }
    throw err;
  }
  try {
    const raw = await readCursorText(options.backupFile);
    const parsed = validateCursor(raw, options.backupFile);
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

interface CliOptions {
  file?: string;
  out?: string;
  from?: string;
  force: boolean;
}

function parseOptions(args: string[]): CliOptions {
  const options: CliOptions = { force: false };
  const seen = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--force") {
      if (seen.has(arg)) throw new Error("duplicate --force option");
      seen.add(arg);
      options.force = true;
      continue;
    }
    if (arg !== "--file" && arg !== "--out" && arg !== "--from") {
      throw new Error(`unknown option: ${arg}`);
    }
    if (seen.has(arg)) throw new Error(`duplicate ${arg} option`);
    seen.add(arg);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a path`);
    options[arg.slice(2) as "file" | "out" | "from"] = value;
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
  if (action !== "backup" && action !== "restore") {
    throw new Error("usage: npm run cursor -- <backup|restore> [--file PATH] [--out PATH|--from PATH] [--force]");
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
