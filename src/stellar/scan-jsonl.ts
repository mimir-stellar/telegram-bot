import { realpathSync } from "node:fs";
import { mkdir, open, rename, unlink, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import type { DecodedEvent } from "./decode.js";
import { eventHistogram, scanJsonReplacer } from "./events.js";
import { MOCK_CURSOR_FILE } from "./mock-constants.js";

export interface ScanJsonlEventLine extends DecodedEvent {
  type: "event";
}

export interface ScanJsonlSummaryLine {
  type: "summary";
  eventCount: number;
  histogram: Record<string, number>;
}

export type ProtectedPathKind = "cursor" | "send-journal" | "state-file";
export type ArchivePathRole = "source" | "destination";

export class ProtectedStatePathError extends Error {
  readonly code = "PROTECTED_STATE_PATH" as const;
  readonly role: ArchivePathRole;
  readonly kind: ProtectedPathKind;
  readonly resolvedPath: string;

  constructor(params: {
    role: ArchivePathRole;
    kind: ProtectedPathKind;
    resolvedPath: string;
    message: string;
  }) {
    super(params.message);
    this.name = "ProtectedStatePathError";
    this.role = params.role;
    this.kind = params.kind;
    this.resolvedPath = params.resolvedPath;
  }
}

export interface LiveStateGuardOptions {
  /** Base working directory for resolving relative paths (defaults to `process.cwd()`). */
  cwd?: string | undefined;
  /** Environment map inspected for configured live state paths (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv | undefined;
  /** Additional live cursor/journal/state file paths to protect. */
  protectedPaths?: readonly string[] | undefined;
  cursorFile?: string | undefined;
  sendJournalFile?: string | undefined;
}

const DEFAULT_PROTECTED_ENTRIES: ReadonlyArray<{ relPath: string; kind: ProtectedPathKind }> = [
  { relPath: "./data/cursor.json", kind: "cursor" },
  { relPath: MOCK_CURSOR_FILE, kind: "cursor" },
  { relPath: "./data/send-journal.jsonl", kind: "send-journal" },
  { relPath: "./data/audit.jsonl", kind: "state-file" },
  { relPath: "./data/dead-letter.json", kind: "state-file" },
  { relPath: "./data/status.json", kind: "state-file" },
  { relPath: "./data/poller.lock", kind: "state-file" },
  { relPath: "./data/counters.json", kind: "state-file" },
];

/**
 * Resolve a filesystem path through symlinks even when the leaf path or
 * intermediate child directories do not exist yet, without opening the target.
 */
export function resolveCanonicalPathSync(targetPath: string, cwd: string = process.cwd()): string {
  const absolute = path.resolve(cwd, targetPath);
  const trailingParts: string[] = [];
  let cursor = absolute;

  for (;;) {
    try {
      const realBase = realpathSync(cursor);
      const joined =
        trailingParts.length > 0
          ? path.join(realBase, ...trailingParts.reverse())
          : realBase;
      const normalized = path.normalize(joined);
      return process.platform === "win32" ? normalized.toLowerCase() : normalized;
    } catch {
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        const normalized = path.normalize(absolute);
        return process.platform === "win32" ? normalized.toLowerCase() : normalized;
      }
      trailingParts.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

function addProtectedWithDerivatives(
  map: Map<string, ProtectedPathKind>,
  rawPath: string | undefined,
  kind: ProtectedPathKind,
  cwd: string,
): void {
  if (!rawPath || typeof rawPath !== "string" || rawPath.trim().length === 0) {
    return;
  }
  const trimmed = rawPath.trim();
  const baseCanonical = resolveCanonicalPathSync(trimmed, cwd);
  map.set(baseCanonical, kind);
  map.set(resolveCanonicalPathSync(`${trimmed}.tmp`, cwd), kind);
  if (kind === "cursor") {
    map.set(resolveCanonicalPathSync(`${trimmed}.bak`, cwd), "cursor");
  }
}

function collectProtectedStateMap(options: LiveStateGuardOptions = {}): Map<string, ProtectedPathKind> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const protectedMap = new Map<string, ProtectedPathKind>();

  for (const entry of DEFAULT_PROTECTED_ENTRIES) {
    addProtectedWithDerivatives(protectedMap, entry.relPath, entry.kind, cwd);
  }

  addProtectedWithDerivatives(protectedMap, env.CURSOR_FILE, "cursor", cwd);
  addProtectedWithDerivatives(protectedMap, env.SEND_JOURNAL_FILE, "send-journal", cwd);
  addProtectedWithDerivatives(protectedMap, env.AUDIT_FILE, "state-file", cwd);
  addProtectedWithDerivatives(protectedMap, env.DEAD_LETTER_FILE, "state-file", cwd);
  addProtectedWithDerivatives(protectedMap, env.STATUS_FILE, "state-file", cwd);
  addProtectedWithDerivatives(protectedMap, env.INSTANCE_LOCK_FILE, "state-file", cwd);
  addProtectedWithDerivatives(protectedMap, env.COUNTERS_FILE, "state-file", cwd);

  addProtectedWithDerivatives(protectedMap, options.cursorFile, "cursor", cwd);
  addProtectedWithDerivatives(protectedMap, options.sendJournalFile, "send-journal", cwd);

  for (const extra of options.protectedPaths ?? []) {
    if (!extra || extra.trim().length === 0) continue;
    const baseName = path.basename(extra).toLowerCase();
    const inferredKind: ProtectedPathKind = baseName.includes("cursor")
      ? "cursor"
      : baseName.includes("journal")
        ? "send-journal"
        : "state-file";
    addProtectedWithDerivatives(protectedMap, extra, inferredKind, cwd);
  }

  return protectedMap;
}

function classifyCorruptCursorDerivative(canonicalPath: string, protectedMap: Map<string, ProtectedPathKind>): ProtectedPathKind | null {
  for (const [protectedCanonical, kind] of protectedMap.entries()) {
    if (kind === "cursor" && canonicalPath.startsWith(`${protectedCanonical}.corrupt.`)) {
      return "cursor";
    }
    if (canonicalPath.startsWith(`${protectedCanonical}${path.sep}`)) {
      return kind;
    }
  }
  return null;
}

/**
 * Verify that `candidatePath` does not resolve (directly, via relative segments,
 * or through symlinks) to a live cursor, send-journal, or state file before
 * opening any file descriptor.
 */
export function assertSafeArchivePath(
  candidatePath: string,
  role: ArchivePathRole,
  options: LiveStateGuardOptions = {},
): string {
  if (typeof candidatePath !== "string" || candidatePath.trim().length === 0) {
    throw new Error(`Archive ${role} path must be a non-empty string`);
  }
  const cwd = options.cwd ?? process.cwd();
  const resolvedCandidate = resolveCanonicalPathSync(candidatePath, cwd);
  const protectedMap = collectProtectedStateMap(options);

  const directKind =
    protectedMap.get(resolvedCandidate) ??
    classifyCorruptCursorDerivative(resolvedCandidate, protectedMap);

  if (directKind !== null) {
    throw new ProtectedStatePathError({
      role,
      kind: directKind,
      resolvedPath: resolvedCandidate,
      message: `Refusing archive ${role} path "${candidatePath}": resolves to live ${directKind} file`,
    });
  }

  return resolvedCandidate;
}

/**
 * Validate both source and destination paths up front before opening either file
 * so live state is untouched if either side resolves to a protected file.
 */
export function assertSafeSourceAndDestinationPaths(
  paths: { sourcePath?: string | undefined; destinationPath?: string | undefined },
  options: LiveStateGuardOptions = {},
): void {
  if (paths.sourcePath !== undefined) {
    assertSafeArchivePath(paths.sourcePath, "source", options);
  }
  if (paths.destinationPath !== undefined) {
    assertSafeArchivePath(paths.destinationPath, "destination", options);
  }
}

/**
 * Format decoded events as JSON Lines (NDJSON): one event line per decoded
 * event followed by a final `{ type: "summary" }` line containing the
 * histogram from {@link eventHistogram}.
 */
export function formatScanJsonl(events: readonly DecodedEvent[]): string {
  const lines: string[] = [];
  for (const event of events) {
    lines.push(JSON.stringify({ type: "event", ...event }, scanJsonReplacer));
  }
  const summary: ScanJsonlSummaryLine = {
    type: "summary",
    eventCount: events.length,
    histogram: eventHistogram([...events]),
  };
  lines.push(JSON.stringify(summary, scanJsonReplacer));
  return lines.join("\n") + "\n";
}

/**
 * Write formatted scan JSONL atomically to `destinationPath` after verifying it
 * does not resolve to a live cursor, send-journal, or state file.
 */
export async function writeScanJsonlFile(
  destinationPath: string,
  events: readonly DecodedEvent[],
  options: LiveStateGuardOptions = {},
): Promise<void> {
  assertSafeArchivePath(destinationPath, "destination", options);
  const absPath = path.resolve(options.cwd ?? process.cwd(), destinationPath);
  await mkdir(path.dirname(absPath), { recursive: true });
  const tmpPath = `${absPath}.${process.pid}.${Date.now()}.tmp`;
  const payload = formatScanJsonl(events);
  try {
    await writeFile(tmpPath, payload, { encoding: "utf8", mode: 0o600 });
    try {
      await chmod(tmpPath, 0o600);
    } catch {
      // ignore on filesystems without POSIX permissions
    }
    await rename(tmpPath, absPath);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}

/**
 * Read decoded events from a JSONL file after verifying `sourcePath` does not
 * resolve to a live cursor, send-journal, or state file before opening it.
 */
export async function readScanJsonlFile(
  sourcePath: string,
  options: LiveStateGuardOptions = {},
): Promise<DecodedEvent[]> {
  assertSafeArchivePath(sourcePath, "source", options);
  const absPath = path.resolve(options.cwd ?? process.cwd(), sourcePath);
  const handle = await open(absPath, "r");
  try {
    const content = await handle.readFile({ encoding: "utf8" });
    const events: DecodedEvent[] = [];
    for (const rawLine of content.split(/\r?\n/)) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (parsed.type === "summary") continue;
      const { type: _ignoredType, ...rest } = parsed;
      events.push(rest as unknown as DecodedEvent);
    }
    return events;
  } finally {
    await handle.close();
  }
}
