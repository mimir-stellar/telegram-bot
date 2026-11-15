/*
 * Offline cursor backup and restore command. It never contacts Stellar or
 * Telegram; restore uses the normal instance lock to exclude a running poller.
 */

import { randomUUID } from "node:crypto";
import { access, link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { pathToFileURL } from "node:url";

import { acquireInstanceLock, InstanceLockError } from "./instanceLock.js";
import {
  classifyCursorFailure,
  parseAndMigrateCursorFile,
  type CursorDiagnosticCategory,
  type CursorDiagnosticCode,
  type CursorFailureDiagnostic,
} from "./poller.js";

export { classifyCursorFailure };
export type { CursorDiagnosticCategory, CursorDiagnosticCode, CursorFailureDiagnostic };

export interface CursorCliFsOps {
  access: typeof access;
  link: typeof link;
  mkdir: typeof mkdir;
  readFile: typeof readFile;
  rename: typeof rename;
  unlink: typeof unlink;
  writeFile: typeof writeFile;
}

export class CursorCliError extends Error {
  readonly category: CursorDiagnosticCategory;
  readonly diagnosticCode: CursorDiagnosticCode;
  readonly operational: boolean;
  readonly errnoCode: string | null;

  constructor(diag: CursorFailureDiagnostic, options?: { cause?: unknown }) {
    super(diag.summary, options);
    this.name = "CursorCliError";
    this.category = diag.category;
    this.diagnosticCode = diag.diagnosticCode;
    this.operational = diag.operational;
    this.errnoCode = diag.errnoCode;
  }
}

export interface BackupCursorOptions {
  cursorFile: string;
  backupFile: string;
  force?: boolean;
  fsOps?: Partial<CursorCliFsOps>;
}

export interface RestoreCursorOptions extends BackupCursorOptions {
  lockFile: string;
}

function resolveFsOps(overrides?: Partial<CursorCliFsOps>): CursorCliFsOps {
  return {
    access: overrides?.access ?? access,
    link: overrides?.link ?? link,
    mkdir: overrides?.mkdir ?? mkdir,
    readFile: overrides?.readFile ?? readFile,
    rename: overrides?.rename ?? rename,
    unlink: overrides?.unlink ?? unlink,
    writeFile: overrides?.writeFile ?? writeFile,
  };
}

async function exists(filePath: string, fsOps: CursorCliFsOps): Promise<boolean> {
  try {
    await fsOps.access(filePath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new CursorCliError(classifyCursorFailure(err, filePath), { cause: err });
  }
}

function validateCursor(
  raw: string,
  sourcePath: string,
): ReturnType<typeof parseAndMigrateCursorFile> {
  try {
    return parseAndMigrateCursorFile(raw);
  } catch (err) {
    throw new CursorCliError(classifyCursorFailure(err, sourcePath), { cause: err });
  }
}

async function writeAtomic(
  filePath: string,
  contents: string,
  replace: boolean,
  fsOps: CursorCliFsOps,
): Promise<void> {
  const dirPath = path.dirname(filePath);
  try {
    await fsOps.mkdir(dirPath, { recursive: true });
  } catch (err) {
    throw new CursorCliError(classifyCursorFailure(err, dirPath), { cause: err });
  }

  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;

  try {
    try {
      await fsOps.writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx" });
    } catch (err) {
      throw new CursorCliError(classifyCursorFailure(err, dirPath), { cause: err });
    }
    if (replace) {
      try {
        await fsOps.rename(temporaryPath, filePath);
      } catch (err) {
        throw new CursorCliError(classifyCursorFailure(err, filePath), { cause: err });
      }
    } else {
      try {
        await fsOps.link(temporaryPath, filePath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error(`destination already exists at ${filePath}; pass --force to overwrite`);
        }
        throw new CursorCliError(classifyCursorFailure(err, filePath), { cause: err });
      }
    }
  } finally {
    await fsOps.unlink(temporaryPath).catch(() => undefined);
  }
}

/** Copy a validated supported cursor snapshot without exposing cursor values. */
export async function backupCursor(options: BackupCursorOptions): Promise<void> {
  const fsOps = resolveFsOps(options.fsOps);
  let raw: string;
  try {
    raw = await fsOps.readFile(options.cursorFile, "utf8");
  } catch (err) {
    throw new CursorCliError(classifyCursorFailure(err, options.cursorFile), { cause: err });
  }
  const parsed = validateCursor(raw, options.cursorFile);
  if (!options.force && (await exists(options.backupFile, fsOps))) {
    throw new Error(`backup already exists at ${options.backupFile}; pass --force to overwrite`);
  }
  await writeAtomic(options.backupFile, raw, options.force === true, fsOps);
  console.log(
    `[cursor] backed up schema=v` + `${parsed.file.version} targets=${Object.keys(parsed.file.targets).length} ` +
      `from ${options.cursorFile} to ${options.backupFile}`,
  );
}

/** Restore a compatible cursor while holding the poller's exclusive lock. */
export async function restoreCursor(options: RestoreCursorOptions): Promise<void> {
  const fsOps = resolveFsOps(options.fsOps);
  let lock: Awaited<ReturnType<typeof acquireInstanceLock>>;
  try {
    lock = await acquireInstanceLock(options.lockFile);
  } catch (err) {
    if (err instanceof InstanceLockError) throw err;
    throw new CursorCliError(classifyCursorFailure(err, options.lockFile), { cause: err });
  }
  try {
    let raw: string;
    try {
      raw = await fsOps.readFile(options.backupFile, "utf8");
    } catch (err) {
      throw new CursorCliError(classifyCursorFailure(err, options.backupFile), { cause: err });
    }
    const parsed = validateCursor(raw, options.backupFile);
    if (!options.force && (await exists(options.cursorFile, fsOps))) {
      throw new Error(`cursor already exists at ${options.cursorFile}; pass --force to replace it`);
    }
    const normalized = `${JSON.stringify(parsed.file, null, 2)}\n`;
    await writeAtomic(options.cursorFile, normalized, options.force === true, fsOps);
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
