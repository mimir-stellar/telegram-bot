import { readFile } from "node:fs/promises";
import { redactText } from "../redact.js";

/** Categories of finding produced by the privacy review. */
export type PrivacyFindingKind = "telegram_chat_id" | "telegram_bot_token" | "secret_strkey" | "url_credential" | "bearer_token" | "credential_assignment";

export interface PrivacyFinding {
  kind: PrivacyFindingKind;
  file: string;
  line: number;
  column: number;
  /** Masked excerpt; never contains the raw secret value. */
  excerpt: string;
}

export interface PrivacyReviewReport {
  filesScanned: number;
  findingCount: number;
  findings: PrivacyFinding[];
}

interface DetectorRule {
  kind: PrivacyFindingKind;
  pattern: RegExp;
}

/**
 * Detectors for private chat identifiers and secret-shaped values. Patterns
 * are non-global templates; a fresh global copy is created per scan.
 */
const DETECTORS: readonly DetectorRule[] = [
  { kind: "telegram_bot_token", pattern: /(?<![A-Za-z0-9_-])\d{6,}:[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/ },
  { kind: "secret_strkey", pattern: /\bS[A-Z2-7]{55}\b/ },
  { kind: "telegram_chat_id", pattern: /(?<![\w-])-100\d{7,}(?!\d)/ },
  { kind: "url_credential", pattern: /\bhttps?:\/\/[^/\s:@]+:[^/\s@]+@/i },
  { kind: "bearer_token", pattern: /\bBearer\s+[A-Za-z0-9._+/=-]{8,}/i },
  {
    kind: "credential_assignment",
    pattern: /\b[A-Za-z0-9_]*(?:token|secret|password|authorization)[A-Za-z0-9_]*\s*[:=]\s*\S{8,}/i,
  },
];

/** Mask a matched value, keeping only a short prefix/suffix for triage. */
export function maskSecret(value: string): string {
  if (value.length <= 8) return "[masked]";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/**
 * Scan text for private identifiers and secret-shaped values. Pure and
 * deterministic: no network access, no clock, no randomness.
 */
export function reviewText(file: string, text: string): PrivacyFinding[] {
  const findings: PrivacyFinding[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((lineText, index) => {
    for (const rule of DETECTORS) {
      const re = new RegExp(rule.pattern.source, rule.pattern.flags.includes("i") ? "gi" : "g");
      let match: RegExpExecArray | null;
      while ((match = re.exec(lineText)) !== null) {
        findings.push({
          kind: rule.kind,
          file,
          line: index + 1,
          column: match.index + 1,
          excerpt: redactText(maskSecret(match[0])),
        });
        if (match[0].length === 0) re.lastIndex += 1;
      }
    }
  });
  findings.sort((a, b) => a.line - b.line || a.column - b.column || a.kind.localeCompare(b.kind));
  return findings;
}

/** Review several in-memory documents; order of `sources` is preserved in output. */
export function buildPrivacyReport(sources: readonly { file: string; text: string }[]): PrivacyReviewReport {
  const findings: PrivacyFinding[] = [];
  for (const source of sources) {
    findings.push(...reviewText(source.file, source.text));
  }
  return { filesScanned: sources.length, findingCount: findings.length, findings };
}

/** Deterministic Markdown rendering of a report. */
export function formatPrivacyReportMarkdown(report: PrivacyReviewReport): string {
  const lines: string[] = ["# Privacy review", "", `Files scanned: ${report.filesScanned}`, `Findings: ${report.findingCount}`, ""];
  if (report.findings.length === 0) {
    lines.push("No private identifiers or secret-shaped values found.");
  } else {
    lines.push("| File | Line | Column | Kind | Excerpt |", "| --- | --- | --- | --- | --- |");
    for (const f of report.findings) {
      lines.push(`| ${f.file} | ${f.line} | ${f.column} | ${f.kind} | ${f.excerpt} |`);
    }
  }
  return lines.join("\n") + "\n";
}

/** CLI entry: review the given local files (no network access). */
export async function runPrivacyReview(files: readonly string[]): Promise<PrivacyReviewReport> {
  const sources: { file: string; text: string }[] = [];
  for (const file of [...files].sort()) {
    sources.push({ file, text: await readFile(file, "utf8") });
  }
  return buildPrivacyReport(sources);
}
