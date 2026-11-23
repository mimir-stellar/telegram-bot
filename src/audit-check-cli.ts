/**
 * Schema checker for audit JSONL files.
 *
 * Detects hand-edited or truncated audit files before they confuse `/audit` reports.
 * Validates:
 *   - JSON syntax
 *   - Known audit kinds
 *   - Detail field size (≤ AUDIT_MAX_DETAIL)
 *   - Timestamp ordering (non-decreasing)
 *
 * Exits non-zero when problems are found.
 */

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { AUDIT_FORMAT_VERSION, AUDIT_MAX_DETAIL, isAuditKind } from "./audit.js";

export interface AuditCheckIssue {
  line: number;
  kind: "invalid_json" | "unknown_kind" | "oversized_detail" | "out_of_order_timestamp" | "wrong_version";
  message: string;
}

export interface AuditCheckResult {
  file: string;
  totalLines: number;
  validEntries: number;
  issues: AuditCheckIssue[];
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

/** Check a single audit JSONL file for schema violations. */
export async function checkAuditFile(file: string): Promise<AuditCheckResult> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return {
      file,
      totalLines: 0,
      validEntries: 0,
      issues: [
        {
          line: 0,
          kind: "invalid_json",
          message: "File not found or unreadable",
        },
      ],
    };
  }

  const lines = raw.split("\n");
  const issues: AuditCheckIssue[] = [];
  let validEntries = 0;
  let lastTimestamp = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (trimmed === "") continue;

    const lineNum = i + 1;

    // Parse JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      issues.push({
        line: lineNum,
        kind: "invalid_json",
        message: "Invalid JSON syntax",
      });
      continue;
    }

    // Validate object shape
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      issues.push({
        line: lineNum,
        kind: "invalid_json",
        message: "Not a JSON object",
      });
      continue;
    }

    const obj = parsed as Record<string, unknown>;

    // Check format version
    if (obj.v !== AUDIT_FORMAT_VERSION) {
      issues.push({
        line: lineNum,
        kind: "wrong_version",
        message: `Expected version ${AUDIT_FORMAT_VERSION}, got ${obj.v ?? "missing"}`,
      });
      continue;
    }

    // Check timestamp
    if (typeof obj.t !== "number" || !Number.isFinite(obj.t)) {
      issues.push({
        line: lineNum,
        kind: "invalid_json",
        message: "Invalid or missing timestamp (t)",
      });
      continue;
    }

    // Check timestamp ordering
    if (obj.t < lastTimestamp) {
      issues.push({
        line: lineNum,
        kind: "out_of_order_timestamp",
        message: `Timestamp ${obj.t} is before previous entry ${lastTimestamp}`,
      });
    }
    lastTimestamp = obj.t;

    // Check kind
    if (!isAuditKind(obj.kind)) {
      issues.push({
        line: lineNum,
        kind: "unknown_kind",
        message: `Unknown audit kind: ${obj.kind ?? "missing"}`,
      });
      continue;
    }

    // Check detail size
    if (obj.detail !== undefined && typeof obj.detail === "string") {
      if (obj.detail.length > AUDIT_MAX_DETAIL) {
        issues.push({
          line: lineNum,
          kind: "oversized_detail",
          message: `Detail field is ${obj.detail.length} characters (max ${AUDIT_MAX_DETAIL})`,
        });
        continue;
      }
    } else if (obj.detail !== undefined) {
      issues.push({
        line: lineNum,
        kind: "invalid_json",
        message: "Detail field is not a string",
      });
      continue;
    }

    // Check source field (optional but must be valid if present)
    if (obj.source !== undefined && obj.source !== "market" && obj.source !== "squad") {
      issues.push({
        line: lineNum,
        kind: "invalid_json",
        message: `Invalid source: ${obj.source} (must be "market" or "squad")`,
      });
      continue;
    }

    validEntries += 1;
  }

  return {
    file,
    totalLines: lines.length,
    validEntries,
    issues,
  };
}

/** Run the CLI and exit with appropriate code. */
export async function runAuditCheckCli(): Promise<void> {
  const file = flag("file") ?? "./data/audit.jsonl";

  const result = await checkAuditFile(file);

  if (result.issues.length === 0) {
    console.log(`✓ ${file}: ${result.validEntries} valid entries, no issues`);
    process.exit(0);
  }

  console.log(`✗ ${file}: ${result.issues.length} issue(s) found`);
  console.log("");

  // Group issues by kind for clearer output
  const byKind = new Map<AuditCheckIssue["kind"], AuditCheckIssue[]>();
  for (const issue of result.issues) {
    const group = byKind.get(issue.kind) ?? [];
    group.push(issue);
    byKind.set(issue.kind, group);
  }

  // Print issues by kind
  for (const [kind, issues] of byKind) {
    console.log(`${kind.toUpperCase()} (${issues.length}):`);
    for (const issue of issues) {
      console.log(`  Line ${issue.line}: ${issue.message}`);
    }
    console.log("");
  }

  console.log(`Summary: ${result.validEntries} valid, ${result.issues.length} invalid`);
  process.exit(1);
}

// CLI entrypoint
const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  runAuditCheckCli().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
