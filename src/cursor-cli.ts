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
  buildCursorBinding,
  buildCursorFile,
  computeTargetBindingFingerprint,
  CursorBindingMismatchError,
  type CursorBindingMismatchReason,
  type CursorTargetBinding,
  parseAndMigrateCursorFile,
  parseCursorBinding,
  verifyCursorBinding,
} from "./poller.js";

export {
  buildCursorBinding,
  computeTargetBindingFingerprint,
  CursorBindingMismatchError,
  type CursorBindingMismatchReason,
  type CursorTargetBinding,
  parseCursorBinding,
  verifyCursorBinding,
};

export interface BackupCursorOptions {
  cursorFile: string;
  backupFile: string;
  force?: boolean;
}

export interface RestoreCursorOptions extends BackupCursorOptions {
  lockFile: string;
}

export interface MigrateCursorBindingOptions {
  cursorFile: string;
  lockFile: string;
  networkPassphrase: string;
  contracts: Record<string, string>;
  backupFile?: string;
  resetAll?: boolean;
  dryRun?: boolean;
  now?: () => Date;
}

export interface MigrateCursorBindingResult {
  cursorFile: string;
  previousFingerprint: string | null;
  newFingerprint: string;
  networkChanged: boolean;
  preservedTargets: string[];
  resetTargets: string[];
  removedTargets: string[];
  dryRun: boolean;
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
 * Explicitly migrate a persisted cursor file to a new network and/or contract
 * fingerprint binding. Unchanged targets on the same network retain their
 * cursor position; changed contracts or network transitions reset affected
 * targets cleanly under the exclusive poller lock.
 */
export async function migrateCursorBinding(
  options: MigrateCursorBindingOptions,
): Promise<MigrateCursorBindingResult> {
  if (typeof options.networkPassphrase !== "string" || options.networkPassphrase.trim().length === 0) {
    throw new Error("migrateCursorBinding requires a non-empty networkPassphrase");
  }
  const nextBinding = buildCursorBinding({
    networkPassphrase: options.networkPassphrase,
    contracts: options.contracts,
  });
  if (Object.keys(nextBinding.contracts).length === 0) {
    throw new Error("migrateCursorBinding requires at least one target contract");
  }

  const nowFn = options.now ?? (() => new Date());
  const lock = options.dryRun ? null : await acquireInstanceLock(options.lockFile);
  try {
    const raw = await readFile(options.cursorFile, "utf8");
    const parsed = validateCursor(raw);
    const persistedBinding = parsed.file.binding;

    if (persistedBinding !== undefined && !options.resetAll) {
      const recomputed = buildCursorBinding({
        networkPassphrase: persistedBinding.networkPassphrase,
        contracts: persistedBinding.contracts,
      });
      if (persistedBinding.fingerprint !== recomputed.fingerprint) {
        throw new CursorBindingMismatchError({
          reason: "fingerprint_tampered",
          changedTargets: Object.keys(nextBinding.contracts),
          persistedFingerprint: persistedBinding.fingerprint,
          expectedFingerprint: nextBinding.fingerprint,
          detail: "persisted cursor binding digest is internally inconsistent; pass --reset-all to cold-start all targets",
        });
      }
    }

    const networkChanged =
      persistedBinding !== undefined &&
      persistedBinding.networkPassphrase !== nextBinding.networkPassphrase;

    const preservedTargets: string[] = [];
    const resetTargets: string[] = [];
    const migratedTargetsList: Array<{
      source: string;
      cursor: string | null;
      lastEventLedger: number | null;
      recentEventIds?: string[];
      rewindFromLedger?: number | null;
    }> = [];

    for (const source of Object.keys(nextBinding.contracts)) {
      const existing = parsed.file.targets[source];
      const sameTargetFingerprint =
        existing !== undefined &&
        !options.resetAll &&
        !networkChanged &&
        (persistedBinding === undefined ||
          persistedBinding.targetFingerprints[source] === nextBinding.targetFingerprints[source]);

      if (sameTargetFingerprint && existing !== undefined) {
        preservedTargets.push(source);
        migratedTargetsList.push({
          source,
          cursor: existing.cursor,
          lastEventLedger: existing.lastEventLedger,
          ...(existing.recentEventIds !== undefined
            ? { recentEventIds: existing.recentEventIds }
            : {}),
          ...(existing.rewindFromLedger !== undefined
            ? { rewindFromLedger: existing.rewindFromLedger }
            : {}),
        });
      } else {
        resetTargets.push(source);
        migratedTargetsList.push({
          source,
          cursor: null,
          lastEventLedger: null,
        });
      }
    }

    const removedTargets = Object.keys(parsed.file.targets).filter(
      (source) => !(source in nextBinding.contracts),
    );

    const nextChainClock =
      !options.resetAll && !networkChanged && parsed.file.chainClockAt !== undefined
        ? parsed.file.chainClockAt
        : undefined;

    const migratedFile = buildCursorFile(
      migratedTargetsList,
      nowFn().toISOString(),
      nextChainClock,
      nextBinding,
    );

    if (!options.dryRun) {
      if (options.backupFile) {
        assertDifferentPaths(options.cursorFile, options.backupFile);
        await writeAtomic(options.backupFile, raw, true);
      }
      await writeAtomic(options.cursorFile, `${JSON.stringify(migratedFile, null, 2)}\n`, true);
    }

    return {
      cursorFile: options.cursorFile,
      previousFingerprint: persistedBinding?.fingerprint ?? null,
      newFingerprint: nextBinding.fingerprint,
      networkChanged,
      preservedTargets,
      resetTargets,
      removedTargets,
      dryRun: Boolean(options.dryRun),
    };
  } finally {
    if (lock) await lock.release();
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
  resetAll: boolean;
  dryRun: boolean;
  json: boolean;
}

function parseOptions(args: string[]): CliOptions {
  const options: CliOptions = { force: false, resetAll: false, dryRun: false, json: false };
  const seen = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--force" || arg === "--reset-all" || arg === "--dry-run" || arg === "--json") {
      if (seen.has(arg)) throw new Error(`duplicate ${arg} option`);
      seen.add(arg);
      if (arg === "--force") options.force = true;
      if (arg === "--reset-all") options.resetAll = true;
      if (arg === "--dry-run") options.dryRun = true;
      if (arg === "--json") options.json = true;
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
    if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a value`);
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
  if (action !== "backup" && action !== "restore" && action !== "migrate") {
    throw new Error(
      "usage: npm run cursor -- <backup|restore|migrate> [--file PATH] [--out PATH|--from PATH] " +
        "[--network-passphrase PASS] [--market-contract ID] [--squad-contract ID] [--reset-all] [--dry-run] [--json] [--force]",
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
    const networkPassphrase =
      options.networkPassphrase ?? process.env.STELLAR_NETWORK_PASSPHRASE ?? "";
    const marketContract = options.marketContract ?? process.env.MARKET_CONTRACT_ID ?? "";
    const squadContract = options.squadContract ?? process.env.SQUAD_CONTRACT_ID ?? "";
    const contracts: Record<string, string> = {};
    if (marketContract) contracts.market = marketContract;
    if (squadContract) contracts.squad = squadContract;

    const result = await migrateCursorBinding({
      cursorFile,
      lockFile,
      networkPassphrase,
      contracts,
      backupFile: options.out ? resolvePath(options.out) : undefined,
      resetAll: options.resetAll,
      dryRun: options.dryRun,
    });
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(
        `[cursor] ${result.dryRun ? "dry-run " : ""}migrated binding fingerprint=${result.newFingerprint.slice(0, 12)}… ` +
          `preserved=[${result.preservedTargets.join(",")}] reset=[${result.resetTargets.join(",")}]`,
      );
    }
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
