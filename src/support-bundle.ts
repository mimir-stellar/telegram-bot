/**
 * Redacted operator support bundle.
 *
 * Produces a single JSON document an operator can attach to an issue without
 * leaking credentials or chat content. Everything here is built from an
 * allowlist: schema versions, health and bounded error summaries. The bundle
 * never contains environment dumps, message text, bot tokens, seed keys, or
 * raw remote payloads.
 *
 * Like the doctor and incident drills, the collector is offline-first: it reads
 * local state files and only optionally probes the loopback health endpoint.
 * The bot remains read-only; this utility never signs or submits anything.
 */

import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { EXIT_ERROR, EXIT_OK } from "./exitCodes.js";
import { runDoctor, type DoctorReport, type DoctorOptions } from "./doctor-cli.js";
import type { HealthReport } from "./health.js";
import { COUNTERS_SCHEMA_VERSION, CURSOR_SCHEMA_VERSION } from "./poller.js";
import { redactText, registerSecret } from "./redact.js";
import { STATUS_SCHEMA_VERSION, boundText } from "./status.js";

/** Bumped when the shape of this bundle changes incompatibly. */
export const SUPPORT_BUNDLE_SCHEMA_VERSION = 1;

/** Maximum length of any error or free-form diagnostic kept in the bundle. */
export const MAX_BUNDLE_ERROR_CHARS = 300;

export interface SchemaProbe {
  present: boolean;
  /** Version read from the file, or null when absent/unparseable. */
  version: number | string | null;
  /** Version this build understands. */
  expected: number;
  /** Bounded, redacted parse/read problem, or null. */
  error: string | null;
}

export interface SupportBundleTarget {
  source: string;
  version: string;
  contractId: string;
  lastEventLedger: number | null;
  cursorStale: boolean;
  cursorStalled: boolean;
  hasError: boolean;
}

export interface SupportBundleHealth {
  ok: boolean;
  status: string;
  service: string;
  version: string;
  network: string;
  uptimeMs: number;
  checkedAt: string;
  poller: {
    running: boolean;
    paused: boolean;
    stopping: boolean;
    cycles: number;
    latestLedger: number | null;
    oldestLedger: number | null;
    consecutiveFailures: number;
    notificationsSent: number;
    notificationsFailed: number;
    eventsSkipped: number;
    notificationsDropped: number;
    deadLetter: { depth: number; enqueued: number; replayed: number; dropped: number };
    lastError: { at: string; message: string } | null;
    targets: SupportBundleTarget[];
  };
}

export interface SupportBundleStatus {
  schemaVersion: number | null;
  generatedAt: string | null;
  running: boolean;
  network: string;
  cycles: number;
  latestLedger: number | null;
  oldestLedger: number | null;
  notificationsSent: number;
  notificationsFailed: number;
  eventsSkipped: number;
  consecutiveFailures: number;
  lastError: { at: string; message: string } | null;
}

export interface SupportBundle {
  schemaVersion: typeof SUPPORT_BUNDLE_SCHEMA_VERSION;
  generatedAt: string;
  service: "mimir-telegram-bot";
  package: { name: string; version: string };
  runtime: { node: string; platform: string; arch: string };
  schemas: {
    supportBundle: typeof SUPPORT_BUNDLE_SCHEMA_VERSION;
    status: SchemaProbe;
    cursor: SchemaProbe;
    counters: SchemaProbe;
    health: { present: boolean; schema: "health-report" };
  };
  health: SupportBundleHealth | null;
  status: SupportBundleStatus | null;
  doctor: { ok: boolean; checks: Array<{ name: string; status: string; message: string }> } | null;
  errors: Array<{ kind: string; message: string }>;
}

export interface BuildSupportBundleInput {
  now?: number;
  packageInfo?: { name?: string; version?: string };
  runtime?: { node?: string; platform?: string; arch?: string };
  schemas?: Partial<Pick<SupportBundle["schemas"], "status" | "cursor" | "counters">>;
  health?: unknown;
  status?: unknown;
  doctor?: DoctorReport | null;
  errors?: Array<{ kind: string; message: unknown }>;
}

function safeString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function safeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function errorSummary(value: unknown): string {
  return boundText(redactText(safeString(value, String(value ?? ""))), MAX_BUNDLE_ERROR_CHARS);
}

function probeSchema(value: unknown, expected: number): SchemaProbe {
  if (value === null || typeof value !== "object") {
    return { present: false, version: null, expected, error: null };
  }
  const record = value as { version?: unknown; schemaVersion?: unknown };
  const version = record.version ?? record.schemaVersion ?? null;
  if (typeof version === "number" || typeof version === "string") {
    return { present: true, version, expected, error: null };
  }
  return { present: true, version: null, expected, error: "schema version missing" };
}

function summarizeHealth(health: unknown): SupportBundleHealth | null {
  if (health === null || typeof health !== "object") return null;
  const h = health as Partial<HealthReport> & Record<string, unknown>;
  const poller = (h.poller ?? {}) as Record<string, unknown>;
  const lastError = poller.lastError as { at?: unknown; message?: unknown } | null | undefined;
  const deadLetter = (poller.deadLetter ?? {}) as Record<string, unknown>;
  const targets = Array.isArray(poller.targets) ? poller.targets : [];

  return {
    ok: h.ok === true,
    status: safeString(h.status, "unknown"),
    service: safeString(h.service, "mimir-telegram-bot"),
    version: safeString(h.version, "unknown"),
    network: safeString(h.network, "unknown"),
    uptimeMs: safeNumber(h.uptimeMs) ?? 0,
    checkedAt: safeString(h.checkedAt),
    poller: {
      running: poller.running === true,
      paused: poller.paused === true,
      stopping: poller.stopping === true,
      cycles: safeNumber(poller.cycles) ?? 0,
      latestLedger: safeNumber(poller.latestLedger),
      oldestLedger: safeNumber(poller.oldestLedger),
      consecutiveFailures: safeNumber(poller.consecutiveFailures) ?? 0,
      notificationsSent: safeNumber(poller.notificationsSent) ?? 0,
      notificationsFailed: safeNumber(poller.notificationsFailed) ?? 0,
      eventsSkipped: safeNumber(poller.eventsSkipped) ?? 0,
      notificationsDropped: safeNumber(poller.notificationsDropped) ?? 0,
      deadLetter: {
        depth: safeNumber(deadLetter.depth) ?? 0,
        enqueued: safeNumber(deadLetter.enqueued) ?? 0,
        replayed: safeNumber(deadLetter.replayed) ?? 0,
        dropped: safeNumber(deadLetter.dropped) ?? 0,
      },
      lastError:
        lastError && lastError.message !== undefined
          ? {
              at: safeString(lastError.at),
              message: errorSummary(lastError.message),
            }
          : null,
      targets: targets.map((target) => {
        const t = target as Record<string, unknown>;
        return {
          source: safeString(t.source, "unknown"),
          version: safeString(t.version, "v1"),
          contractId: safeString(t.contractId),
          lastEventLedger: safeNumber(t.lastEventLedger),
          cursorStale: t.cursorStale === true,
          cursorStalled: t.cursorStalled === true,
          hasError: t.hasError === true,
        };
      }),
    },
  };
}

function summarizeStatus(status: unknown): SupportBundleStatus | null {
  if (status === null || typeof status !== "object") return null;
  const s = status as Record<string, unknown>;
  const lastError = s.lastError as { at?: unknown; message?: unknown } | null | undefined;
  return {
    schemaVersion: safeNumber(s.schemaVersion),
    generatedAt: typeof s.generatedAt === "string" ? s.generatedAt : null,
    running: s.running === true,
    network: safeString(s.network, "unknown"),
    cycles: safeNumber(s.cycles) ?? 0,
    latestLedger: safeNumber(s.latestLedger),
    oldestLedger: safeNumber(s.oldestLedger),
    notificationsSent: safeNumber(s.notificationsSent) ?? 0,
    notificationsFailed: safeNumber(s.notificationsFailed) ?? 0,
    eventsSkipped: safeNumber(s.eventsSkipped) ?? 0,
    consecutiveFailures: safeNumber(s.consecutiveFailures) ?? 0,
    lastError:
      lastError && lastError.message !== undefined
        ? {
            at: typeof lastError.at === "number" ? new Date(lastError.at).toISOString() : safeString(lastError.at),
            message: errorSummary(lastError.message),
          }
        : null,
  };
}

function summarizeDoctor(doctor: DoctorReport | null | undefined): SupportBundle["doctor"] {
  if (!doctor || !Array.isArray(doctor.checks)) return null;
  return {
    ok: doctor.ok === true,
    checks: doctor.checks.map((check) => ({
      name: safeString(check.name, "unknown"),
      status: safeString(check.status, "unknown"),
      message: boundText(redactText(safeString(check.message)), MAX_BUNDLE_ERROR_CHARS),
    })),
  };
}

/**
 * Assemble a support bundle from already-collected inputs. Pure apart from the
 * one clock read, so tests can pin every field without touching the network.
 */
export function buildSupportBundle(input: BuildSupportBundleInput = {}): SupportBundle {
  const now = input.now ?? Date.now();
  const health = summarizeHealth(input.health);
  const status = summarizeStatus(input.status);
  const doctor = summarizeDoctor(input.doctor);

  const errors: SupportBundle["errors"] = [];
  for (const entry of input.errors ?? []) {
    const message = errorSummary(entry.message);
    if (message) errors.push({ kind: safeString(entry.kind, "error"), message });
  }
  if (health?.poller.lastError) {
    errors.push({ kind: "health.lastError", message: health.poller.lastError.message });
  }
  if (status?.lastError) {
    errors.push({ kind: "status.lastError", message: status.lastError.message });
  }
  for (const check of doctor?.checks ?? []) {
    if (check.status === "FAIL") {
      errors.push({ kind: `doctor.${check.name}`, message: check.message });
    }
  }

  return {
    schemaVersion: SUPPORT_BUNDLE_SCHEMA_VERSION,
    generatedAt: new Date(now).toISOString(),
    service: "mimir-telegram-bot",
    package: {
      name: safeString(input.packageInfo?.name, "unknown"),
      version: safeString(input.packageInfo?.version, "unknown"),
    },
    runtime: {
      node: safeString(input.runtime?.node, process.version),
      platform: safeString(input.runtime?.platform, process.platform),
      arch: safeString(input.runtime?.arch, process.arch),
    },
    schemas: {
      supportBundle: SUPPORT_BUNDLE_SCHEMA_VERSION,
      status: input.schemas?.status ?? probeSchema(input.status, STATUS_SCHEMA_VERSION),
      cursor: input.schemas?.cursor ?? probeSchema(null, CURSOR_SCHEMA_VERSION),
      counters: input.schemas?.counters ?? probeSchema(null, COUNTERS_SCHEMA_VERSION),
      health: { present: health !== null, schema: "health-report" },
    },
    health,
    status,
    doctor,
    errors,
  };
}

export interface CollectSupportBundleOptions extends DoctorOptions {
  now?: number;
  statusPath?: string;
  cursorPath?: string;
  countersPath?: string;
  packageJsonPath?: string;
  healthUrl?: string | null;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Health-probe timeout in milliseconds. */
  healthTimeoutMs?: number;
}

function readJsonFile(file: string): { present: boolean; value: unknown; error: string | null } {
  if (!existsSync(file)) return { present: false, value: null, error: null };
  try {
    return { present: true, value: JSON.parse(readFileSync(file, "utf8")) as unknown, error: null };
  } catch (err) {
    return {
      present: true,
      value: null,
      error: errorSummary(err instanceof Error ? err.message : String(err)),
    };
  }
}

function probeFile(file: string, expected: number): { probe: SchemaProbe; value: unknown } {
  const read = readJsonFile(file);
  if (!read.present) {
    return { probe: { present: false, version: null, expected, error: null }, value: null };
  }
  if (read.error) {
    return {
      probe: { present: true, version: null, expected, error: read.error },
      value: read.value,
    };
  }
  const probe = probeSchema(read.value, expected);
  return { probe: { ...probe, error: probe.error ?? read.error }, value: read.value };
}

function readPackageInfo(cwd: string, explicitPath?: string): { name: string; version: string } {
  const candidates = explicitPath
    ? [explicitPath]
    : [path.join(cwd, "package.json"), path.join(path.dirname(fileURLToPath(import.meta.url)), "../package.json")];
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue;
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { name?: unknown; version?: unknown };
      if (typeof parsed.name === "string" || typeof parsed.version === "string") {
        return {
          name: typeof parsed.name === "string" ? parsed.name : "unknown",
          version: typeof parsed.version === "string" ? parsed.version : "unknown",
        };
      }
    } catch {
      // A malformed local package.json is a diagnostic, not a reason to fail.
    }
  }
  return { name: "unknown", version: "unknown" };
}

async function probeHealth(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<{ health: unknown; error: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    const response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    const text = await response.text();
    try {
      return { health: JSON.parse(text) as unknown, error: null };
    } catch {
      return {
        health: null,
        error: `health endpoint returned non-JSON (HTTP ${response.status})`,
      };
    }
  } catch (err) {
    return {
      health: null,
      error: `health endpoint unavailable: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Collect a support bundle from a checkout and its local state files.
 *
 * The health probe is optional and defaults to the configured loopback health
 * listener only when `healthUrl` is provided. Any failure to read a state file
 * or reach health is recorded as a bounded diagnostic; generation still
 * succeeds so the operator gets the rest of the context.
 */
export async function collectSupportBundle(
  options: CollectSupportBundleOptions = {},
): Promise<SupportBundle> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;

  if (env.BOT_TOKEN) registerSecret(env.BOT_TOKEN);

  const statusPath = path.resolve(cwd, options.statusPath ?? env.STATUS_FILE ?? "./data/status.json");
  const cursorPath = path.resolve(cwd, options.cursorPath ?? env.CURSOR_FILE ?? "./data/cursor.json");
  const countersPath = path.resolve(
    cwd,
    options.countersPath ?? env.COUNTERS_FILE ?? "./data/counters.json",
  );

  const doctor = await runDoctor({ ...options, cwd, env });
  const statusRead = probeFile(statusPath, STATUS_SCHEMA_VERSION);
  const cursorRead = probeFile(cursorPath, CURSOR_SCHEMA_VERSION);
  const countersRead = probeFile(countersPath, COUNTERS_SCHEMA_VERSION);

  let health: unknown = null;
  const errors: Array<{ kind: string; message: unknown }> = [];
  if (options.healthUrl) {
    const probe = await probeHealth(
      options.healthUrl,
      options.fetchImpl ?? fetch,
      options.healthTimeoutMs ?? 2_000,
    );
    health = probe.health;
    if (probe.error) errors.push({ kind: "health", message: probe.error });
  }
  if (statusRead.probe.error) errors.push({ kind: "status-file", message: statusRead.probe.error });
  if (cursorRead.probe.error) errors.push({ kind: "cursor-file", message: cursorRead.probe.error });
  if (countersRead.probe.error) errors.push({ kind: "counters-file", message: countersRead.probe.error });

  return buildSupportBundle({
    now: options.now,
    packageInfo: readPackageInfo(cwd, options.packageJsonPath),
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    schemas: {
      status: statusRead.probe,
      cursor: cursorRead.probe,
      counters: countersRead.probe,
    },
    health,
    status: statusRead.value,
    doctor,
    errors,
  });
}

export function serializeSupportBundle(bundle: SupportBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function argValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Mimir redacted operator support bundle
Usage: npm run support-bundle [-- [options]]

Options:
  --status <path>       Status snapshot file (default: STATUS_FILE or ./data/status.json)
  --cursor <path>       Cursor file (default: CURSOR_FILE or ./data/cursor.json)
  --counters <path>     Counters file (default: COUNTERS_FILE or ./data/counters.json)
  --health-url <url>    Optional health endpoint to probe
  --out <path>          Write the bundle to a file instead of stdout
  --help, -h            Show this help message

The bundle contains schema versions, health and bounded error summaries only.
Tokens, private messages and complete environment dumps are never included.
`);
    return;
  }

  const bundle = await collectSupportBundle({
    statusPath: argValue(args, "--status"),
    cursorPath: argValue(args, "--cursor"),
    countersPath: argValue(args, "--counters"),
    healthUrl: argValue(args, "--health-url") ?? null,
  });

  const output = serializeSupportBundle(bundle);
  const out = argValue(args, "--out");
  if (out) {
    await writeFile(path.resolve(out), output, "utf8");
    console.log(`[support-bundle] wrote ${path.resolve(out)}`);
  } else {
    process.stdout.write(output);
  }
  process.exit(bundle.doctor?.ok === false ? EXIT_ERROR : EXIT_OK);
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(path.resolve(invokedPath)).href) {
  main().catch((err: unknown) => {
    console.error(`[support-bundle] unexpected error: ${errorSummary(err)}`);
    process.exit(EXIT_ERROR);
  });
}
