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
  type CursorFile,
  type CursorOwnership,
  CursorOwnershipMismatchError,
  type CursorOwnershipMismatchReason,
  KNOWN_CURSOR_TARGETS,
  parseAndMigrateCursorFile,
  parseCursorOwnership,
  validateCursorBackupOwnership,
} from "./poller.js";

export {
  type CursorOwnership,
  CursorOwnershipMismatchError,
  type CursorOwnershipMismatchReason,
  KNOWN_CURSOR_TARGETS,
  parseCursorOwnership,
  validateCursorBackupOwnership,
};

export interface BackupCursorOptions {
  cursorFile: string;
  backupFile: string;
  force?: boolean;
}

export interface RestoreCursorOptions extends BackupCursorOptions {
  lockFile: string;
  expectedContracts?: Record<string, string>;
  expectedNetworkPassphrase?: string;
  allowedTargets?: readonly string[];
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
    const liveExists = await exists(options.cursorFile);
    if (!options.force && liveExists) {
      throw new Error(`cursor already exists at ${options.cursorFile}; pass --force to replace it`);
    }

    let liveFile: CursorFile | null = null;
    if (liveExists) {
      try {
        const liveRaw = await readFile(options.cursorFile, "utf8");
        liveFile = parseAndMigrateCursorFile(liveRaw).file;
      } catch {
        // Corrupt/unreadable live cursor can still be recovered by an owned valid backup.
        liveFile = null;
      }
    }

    validateCursorBackupOwnership({
      backupFile: parsed.file,
      liveFile,
      expectedContracts: options.expectedContracts,
      expectedNetworkPassphrase: options.expectedNetworkPassphrase,
      allowedTargets: options.allowedTargets,
    });

    if (parsed.file.ownership === undefined) {
      const inheritedOwnership = parseCursorOwnership({
        contracts: {
          ...(liveFile?.ownership?.contracts ?? {}),
          ...(options.expectedContracts ?? {}),
        },
        networkPassphrase:
          options.expectedNetworkPassphrase ?? liveFile?.ownership?.networkPassphrase,
      });
      if (inheritedOwnership !== undefined) {
        parsed.file.ownership = inheritedOwnership;
      }
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
  marketContract?: string;
  squadContract?: string;
  networkPassphrase?: string;
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
    if (
      arg !== "--file" &&
      arg !== "--out" &&
      arg !== "--from" &&
      arg !== "--market-contract" &&
      arg !== "--squad-contract" &&
      arg !== "--network-passphrase"
    ) {
      throw new Error(`unknown option: ${arg}`);
    }
    if (seen.has(arg)) throw new Error(`duplicate ${arg} option`);
    seen.add(arg);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${arg} requires a value`);
    }
    if (arg === "--market-contract") options.marketContract = value;
    else if (arg === "--squad-contract") options.squadContract = value;
    else if (arg === "--network-passphrase") options.networkPassphrase = value;
    else options[arg.slice(2) as "file" | "out" | "from"] = value;
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
    throw new Error(
      "usage: npm run cursor -- <backup|restore> [--file PATH] [--out PATH|--from PATH] " +
        "[--market-contract ID] [--squad-contract ID] [--network-passphrase PASS] [--force]",
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

  if (!options.from) throw new Error("restore requires --from PATH");
  const backupFile = resolvePath(options.from);
  assertDifferentPaths(cursorFile, backupFile);
  const lockFile = resolvePath(process.env.INSTANCE_LOCK_FILE ?? "./data/poller.lock");
  const expectedContracts: Record<string, string> = {};
  const marketContract = options.marketContract ?? process.env.MARKET_CONTRACT_ID;
  const squadContract = options.squadContract ?? process.env.SQUAD_CONTRACT_ID;
  if (marketContract) expectedContracts.market = marketContract;
  if (squadContract) expectedContracts.squad = squadContract;
  const expectedNetworkPassphrase =
    options.networkPassphrase ?? process.env.STELLAR_NETWORK_PASSPHRASE;

  await restoreCursor({
    cursorFile,
    backupFile,
    lockFile,
    force: options.force,
    ...(Object.keys(expectedContracts).length > 0 ? { expectedContracts } : {}),
    ...(expectedNetworkPassphrase ? { expectedNetworkPassphrase } : {}),
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
