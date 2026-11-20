/*
 * Offline cursor backup and restore command. It never contacts Stellar or
 * Telegram; restore uses the normal instance lock to exclude a running poller.
 */

import { randomUUID } from "node:crypto";
import { access, link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { pathToFileURL } from "node:url";

import { NETWORK_PASSPHRASES } from "./config.js";
import { acquireInstanceLock } from "./instanceLock.js";
import { computeCursorTargetFingerprint, parseAndMigrateCursorFile } from "./poller.js";

export interface TargetFingerprintConfig {
  networkPassphrase: string;
  marketContractId: string;
  squadContractId: string;
}

export interface BackupCursorOptions {
  cursorFile: string;
  backupFile: string;
  force?: boolean;
}

export interface RestoreCursorOptions extends BackupCursorOptions {
  lockFile: string;
  targets?: TargetFingerprintConfig;
}

export interface MigrateCursorOptions extends TargetFingerprintConfig {
  cursorFile: string;
  lockFile: string;
  force?: boolean;
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

function expectedFingerprints(
  config: TargetFingerprintConfig,
): Record<string, string> {
  return {
    market: computeCursorTargetFingerprint(config.networkPassphrase, config.marketContractId),
    squad: computeCursorTargetFingerprint(config.networkPassphrase, config.squadContractId),
  };
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
    if (options.targets) {
      const expected = expectedFingerprints(options.targets);
      for (const [source, entry] of Object.entries(parsed.file.targets)) {
        const expectedFp = expected[source];
        if (!expectedFp) continue;
        if (entry.fingerprint !== undefined && entry.fingerprint !== expectedFp) {
          if (!options.force) {
            throw new Error(
              `backup target ${source} is bound to a different network or contract fingerprint; ` +
                `pass --force to reset incompatible targets`,
            );
          }
          parsed.file.targets[source] = {
            cursor: null,
            lastEventLedger: null,
            fingerprint: expectedFp,
          };
        } else if (entry.fingerprint === undefined) {
          entry.fingerprint = expectedFp;
        }
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

/**
 * Explicitly migrate a persisted cursor file to the configured network and
 * contract fingerprints while holding the poller's exclusive lock.
 *
 * Legacy targets without a fingerprint are bound in-place, preserving their
 * cursor position. Targets bound to a different fingerprint are rejected
 * unless `force` is true, in which case they are reset to a cold start.
 */
export async function migrateCursor(options: MigrateCursorOptions): Promise<{
  bound: number;
  reset: number;
}> {
  const lock = await acquireInstanceLock(options.lockFile);
  try {
    const raw = await readFile(options.cursorFile, "utf8");
    const parsed = validateCursor(raw);
    const expected = expectedFingerprints(options);
    let bound = 0;
    let reset = 0;

    for (const [source, entry] of Object.entries(parsed.file.targets)) {
      const expectedFp = expected[source];
      if (!expectedFp) continue;
      if (entry.fingerprint === undefined) {
        entry.fingerprint = expectedFp;
        bound += 1;
      } else if (entry.fingerprint !== expectedFp) {
        if (!options.force) {
          throw new Error(
            `cursor target ${source} is bound to a different network or contract fingerprint; ` +
              `pass --force to reset incompatible targets`,
          );
        }
        parsed.file.targets[source] = {
          cursor: null,
          lastEventLedger: null,
          fingerprint: expectedFp,
        };
        reset += 1;
      }
    }

    parsed.file.updatedAt = new Date().toISOString();
    const normalized = `${JSON.stringify(parsed.file, null, 2)}\n`;
    await writeAtomic(options.cursorFile, normalized, true);
    console.log(
      `[cursor] migrated schema=v${parsed.file.version} bound=${bound} reset=${reset} ` +
        `at ${options.cursorFile}`,
    );
    return { bound, reset };
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

function resolveTargetConfigFromEnv(): TargetFingerprintConfig | undefined {
  const marketContractId = process.env.MARKET_CONTRACT_ID?.trim();
  const squadContractId = process.env.SQUAD_CONTRACT_ID?.trim();
  if (!marketContractId || !squadContractId) return undefined;

  const network = process.env.STELLAR_NETWORK?.trim().toLowerCase();
  const defaultPassphrase =
    network === "mainnet" || network === "futurenet" || network === "testnet"
      ? NETWORK_PASSPHRASES[network]
      : NETWORK_PASSPHRASES.testnet;
  const networkPassphrase =
    process.env.STELLAR_NETWORK_PASSPHRASE?.trim() || defaultPassphrase;

  return { networkPassphrase, marketContractId, squadContractId };
}

async function main(): Promise<void> {
  loadDotenv({ path: process.env.DOTENV_CONFIG_PATH || ".env" });
  const [action, ...args] = process.argv.slice(2);
  if (action !== "backup" && action !== "restore" && action !== "migrate") {
    throw new Error(
      "usage: npm run cursor -- <backup|restore|migrate> [--file PATH] [--out PATH|--from PATH] [--force]",
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

  const lockFile = resolvePath(process.env.INSTANCE_LOCK_FILE ?? "./data/poller.lock");
  if (action === "migrate") {
    const targets = resolveTargetConfigFromEnv();
    if (!targets) {
      throw new Error("migrate requires MARKET_CONTRACT_ID and SQUAD_CONTRACT_ID");
    }
    await migrateCursor({
      cursorFile,
      lockFile,
      force: options.force,
      ...targets,
    });
    return;
  }

  if (!options.from) throw new Error("restore requires --from PATH");
  const backupFile = resolvePath(options.from);
  assertDifferentPaths(cursorFile, backupFile);
  await restoreCursor({
    cursorFile,
    backupFile,
    lockFile,
    force: options.force,
    targets: resolveTargetConfigFromEnv(),
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
