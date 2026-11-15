import { registeredSecrets } from "../redact.js";
import type { DecodedEvent } from "./decode.js";
import { eventHistogram, scanJsonReplacer } from "./events.js";

export interface ScanJsonlEventLine extends DecodedEvent {
  type: "event";
}

export interface ScanJsonlSummaryLine {
  type: "summary";
  eventCount: number;
  histogram: Record<string, number>;
}

export type PrivacyFindingCategory =
  | "secret"
  | "private_chat_id"
  | "malformed_record"
  | "public_address";

export type PrivacyFindingSeverity = "high" | "medium";

export interface PrivacyReviewFinding {
  severity: PrivacyFindingSeverity;
  category: PrivacyFindingCategory;
  ruleId: string;
  source: string;
  line: number;
  fieldPath: string;
  message: string;
}

export interface PrivacyReviewOptions {
  /** Extra secret strings that must never appear in a shareable archive. */
  knownSecrets?: readonly string[] | undefined;
  /** Known private chat/user IDs or handles to detect even in arbitrary text. */
  knownChatIds?: readonly (string | number)[] | undefined;
  /** Logical source label used for JSONL input reports (default: "<jsonl>"). */
  sourceName?: string | undefined;
  /** Optional strict check flagging un-anonymised public Stellar G... addresses. */
  flagPublicAccountAddresses?: boolean | undefined;
}

export interface PrivacyReviewReport {
  format: "mimir-privacy-review-v1";
  shareable: boolean;
  filesScanned: number;
  linesScanned: number;
  recordsScanned: number;
  findingCount: number;
  countsByCategory: Record<PrivacyFindingCategory, number>;
  countsByRule: Record<string, number>;
  findings: PrivacyReviewFinding[];
}

const CHAT_ID_FIELD_RE =
  /^(?:telegram[_-]?)?(?:chat|user|admin[_-]?user|recipient[_-]?chat|from|sender|message[_-]?thread|thread)[_-]?ids?$/i;

const SECRET_FIELD_RE =
  /^(?:bot[_-]?token|telegram[_-]?bot[_-]?token|api[_-]?key|access[_-]?token|auth[_-]?token|webhook[_-]?secret|private[_-]?key|secret[_-]?key|seed|password|authorization|secret|token)$/i;

const BOT_TOKEN_RE = /(?:\bbot)?(?<![A-Za-z0-9_-])\d{6,}:[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/;
const STELLAR_SECRET_SEED_RE = /\bS[A-Z2-7]{55}\b/;
const PUBLIC_ACCOUNT_STRKEY_RE = /\bG[A-Z2-7]{55}\b/;
const PEM_PRIVATE_KEY_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const URL_USERINFO_RE = /\bhttps?:\/\/[^/\s:@]+:[^/\s@]+@/i;
const URL_CREDENTIAL_PARAM_RE =
  /[?&#](?:token|api[_-]?key|access[_-]?token|auth[_-]?token|key|secret|password|auth)=[^&#\s]+/i;
const BEARER_TOKEN_RE = /\bBearer\s+[A-Za-z0-9._+/=-]{8,}/i;
const KV_CREDENTIAL_RE =
  /\b(?:[A-Za-z0-9_]*(?:token|secret|password|authorization|api_key)[A-Za-z0-9_]*)\s*[:=]\s*(?!\[REDACTED\b)(?!unset\b)\S{8,}/i;

// Telegram supergroup / channel numeric IDs (-100xxxxxxxxxx) or explicit chat assignments, invite links, and @handles.
const TELEGRAM_SUPERGROUP_ID_RE = /(?:^|[^0-9])-100\d{7,15}(?!\d)/;
const TELEGRAM_INVITE_LINK_RE = /\b(?:https?:\/\/)?t\.me\/(?:\+|joinchat\/)[A-Za-z0-9_-]+/i;
const TELEGRAM_CHAT_ASSIGNMENT_RE =
  /\b(?:telegram[_-]?)?(?:chat|user|thread)[_-]?id\s*[:=]\s*(?:-?\d{5,16}|@[A-Za-z][A-Za-z0-9_]{4,31})\b/i;
const TELEGRAM_HANDLE_RE =
  /(?<![A-Za-z0-9._%+-:/])@[A-Za-z][A-Za-z0-9_]{4,31}\b(?![A-Za-z0-9_-]*\.[A-Za-z]{2,})/;

function isAlreadyRedactedValue(val: string): boolean {
  const trimmed = val.trim();
  return (
    trimmed.length === 0 ||
    trimmed === "[REDACTED]" ||
    /^\[redacted(?::[^\]]+)?\]$/i.test(trimmed)
  );
}

function formatChildPath(parentPath: string, key: string | number): string {
  if (typeof key === "number") {
    return `${parentPath}[${key}]`;
  }
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) {
    return `${parentPath}.${key}`;
  }
  return `${parentPath}[${JSON.stringify(key)}]`;
}

export interface PrivacyScanSegment {
  source: string;
  content: string;
}

function scanStringForFindings(
  text: string,
  ctx: {
    source: string;
    line: number;
    fieldPath: string;
    knownSecrets: readonly string[];
    knownChatIds: readonly string[];
    flagPublicAccountAddresses: boolean;
  },
  out: PrivacyReviewFinding[],
): void {
  if (!text || isAlreadyRedactedValue(text)) return;

  for (const secret of ctx.knownSecrets) {
    if (secret.length >= 4 && text.includes(secret)) {
      out.push({
        severity: "high",
        category: "secret",
        ruleId: "known_secret",
        source: ctx.source,
        line: ctx.line,
        fieldPath: ctx.fieldPath,
        message: "Matched a registered or caller-supplied secret value",
      });
      break;
    }
  }

  for (const chatId of ctx.knownChatIds) {
    if (chatId.length >= 3 && text.includes(chatId)) {
      out.push({
        severity: "high",
        category: "private_chat_id",
        ruleId: "known_chat_id",
        source: ctx.source,
        line: ctx.line,
        fieldPath: ctx.fieldPath,
        message: "Matched a configured private chat or user identifier",
      });
      break;
    }
  }

  if (BOT_TOKEN_RE.test(text)) {
    out.push({
      severity: "high",
      category: "secret",
      ruleId: "telegram_bot_token",
      source: ctx.source,
      line: ctx.line,
      fieldPath: ctx.fieldPath,
      message: "Detected Telegram bot token shape",
    });
  }

  if (STELLAR_SECRET_SEED_RE.test(text)) {
    out.push({
      severity: "high",
      category: "secret",
      ruleId: "stellar_secret_seed",
      source: ctx.source,
      line: ctx.line,
      fieldPath: ctx.fieldPath,
      message: "Detected Stellar secret seed strkey (S...)",
    });
  }

  if (PEM_PRIVATE_KEY_RE.test(text)) {
    out.push({
      severity: "high",
      category: "secret",
      ruleId: "pem_private_key",
      source: ctx.source,
      line: ctx.line,
      fieldPath: ctx.fieldPath,
      message: "Detected PEM private key header",
    });
  }

  if (URL_USERINFO_RE.test(text) || URL_CREDENTIAL_PARAM_RE.test(text)) {
    out.push({
      severity: "high",
      category: "secret",
      ruleId: "url_credential",
      source: ctx.source,
      line: ctx.line,
      fieldPath: ctx.fieldPath,
      message: "Detected credential-bearing URL userinfo, query parameter, or fragment",
    });
  }

  if (BEARER_TOKEN_RE.test(text)) {
    out.push({
      severity: "high",
      category: "secret",
      ruleId: "bearer_token",
      source: ctx.source,
      line: ctx.line,
      fieldPath: ctx.fieldPath,
      message: "Detected Bearer authorization token",
    });
  }

  if (KV_CREDENTIAL_RE.test(text)) {
    out.push({
      severity: "high",
      category: "secret",
      ruleId: "credential_assignment",
      source: ctx.source,
      line: ctx.line,
      fieldPath: ctx.fieldPath,
      message: "Detected secret/token key-value assignment in text",
    });
  }

  if (TELEGRAM_SUPERGROUP_ID_RE.test(text)) {
    out.push({
      severity: "high",
      category: "private_chat_id",
      ruleId: "telegram_supergroup_id",
      source: ctx.source,
      line: ctx.line,
      fieldPath: ctx.fieldPath,
      message: "Detected Telegram group/channel numeric chat ID (-100...)",
    });
  }

  if (TELEGRAM_INVITE_LINK_RE.test(text)) {
    out.push({
      severity: "high",
      category: "private_chat_id",
      ruleId: "telegram_invite_link",
      source: ctx.source,
      line: ctx.line,
      fieldPath: ctx.fieldPath,
      message: "Detected private Telegram invite link",
    });
  }

  if (TELEGRAM_CHAT_ASSIGNMENT_RE.test(text)) {
    out.push({
      severity: "high",
      category: "private_chat_id",
      ruleId: "telegram_chat_assignment",
      source: ctx.source,
      line: ctx.line,
      fieldPath: ctx.fieldPath,
      message: "Detected inline Telegram chat/user identifier assignment",
    });
  }

  if (TELEGRAM_HANDLE_RE.test(text)) {
    out.push({
      severity: "medium",
      category: "private_chat_id",
      ruleId: "telegram_handle",
      source: ctx.source,
      line: ctx.line,
      fieldPath: ctx.fieldPath,
      message: "Detected Telegram @handle identifier",
    });
  }

  if (ctx.flagPublicAccountAddresses && PUBLIC_ACCOUNT_STRKEY_RE.test(text)) {
    out.push({
      severity: "medium",
      category: "public_address",
      ruleId: "stellar_public_account",
      source: ctx.source,
      line: ctx.line,
      fieldPath: ctx.fieldPath,
      message: "Detected un-anonymised public Stellar account address (G...)",
    });
  }
}

function walkRecordForPrivacy(
  value: unknown,
  fieldPath: string,
  keyName: string | null,
  ctx: {
    source: string;
    line: number;
    knownSecrets: readonly string[];
    knownChatIds: readonly string[];
    flagPublicAccountAddresses: boolean;
  },
  out: PrivacyReviewFinding[],
): void {
  if (keyName !== null) {
    if (CHAT_ID_FIELD_RE.test(keyName) && value !== null && value !== undefined) {
      const asStr = typeof value === "string" ? value : JSON.stringify(value);
      if (!isAlreadyRedactedValue(asStr) && !(Array.isArray(value) && value.length === 0)) {
        out.push({
          severity: "high",
          category: "private_chat_id",
          ruleId: "chat_id_field",
          source: ctx.source,
          line: ctx.line,
          fieldPath,
          message: `Record contains private chat/user identifier field "${keyName}"`,
        });
      }
    } else if (SECRET_FIELD_RE.test(keyName) && value !== null && value !== undefined) {
      const asStr = typeof value === "string" ? value : JSON.stringify(value);
      if (!isAlreadyRedactedValue(asStr)) {
        out.push({
          severity: "high",
          category: "secret",
          ruleId: "secret_field",
          source: ctx.source,
          line: ctx.line,
          fieldPath,
          message: `Record contains credential-named field "${keyName}"`,
        });
      }
    }
  }

  if (typeof value === "string") {
    scanStringForFindings(value, { ...ctx, fieldPath }, out);
    return;
  }

  if (typeof value === "number" || typeof value === "bigint") {
    const strVal = String(value);
    for (const chatId of ctx.knownChatIds) {
      if (chatId === strVal) {
        out.push({
          severity: "high",
          category: "private_chat_id",
          ruleId: "known_chat_id",
          source: ctx.source,
          line: ctx.line,
          fieldPath,
          message: "Matched a configured numeric chat or user identifier",
        });
        break;
      }
    }
    if (TELEGRAM_SUPERGROUP_ID_RE.test(strVal)) {
      out.push({
        severity: "high",
        category: "private_chat_id",
        ruleId: "telegram_supergroup_id",
        source: ctx.source,
        line: ctx.line,
        fieldPath,
        message: "Detected Telegram group/channel numeric chat ID (-100...)",
      });
    }
    return;
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      walkRecordForPrivacy(value[i], formatChildPath(fieldPath, i), null, ctx, out);
    }
    return;
  }

  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    for (const key of keys) {
      walkRecordForPrivacy(
        (value as Record<string, unknown>)[key],
        formatChildPath(fieldPath, key),
        key,
        ctx,
        out,
      );
    }
  }
}

function compareFindings(a: PrivacyReviewFinding, b: PrivacyReviewFinding): number {
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  if (a.line !== b.line) return a.line - b.line;
  if (a.fieldPath !== b.fieldPath) return a.fieldPath < b.fieldPath ? -1 : 1;
  if (a.category !== b.category) return a.category < b.category ? -1 : 1;
  if (a.ruleId !== b.ruleId) return a.ruleId < b.ruleId ? -1 : 1;
  return a.message < b.message ? -1 : a.message > b.message ? 1 : 0;
}

export function reviewPrivacySegments(
  segments: readonly PrivacyScanSegment[],
  options: PrivacyReviewOptions = {},
): PrivacyReviewReport {
  const knownSecrets = [
    ...registeredSecrets(),
    ...(options.knownSecrets ?? []),
  ]
    .filter((s) => typeof s === "string" && s.trim().length >= 4)
    .map((s) => s.trim())
    .sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));

  const knownChatIds = (options.knownChatIds ?? [])
    .map((v) => String(v).trim())
    .filter((v) => v.length >= 3)
    .sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));

  const flagPublicAccountAddresses = options.flagPublicAccountAddresses === true;

  const sortedSegments = [...segments].sort((a, b) =>
    a.source < b.source ? -1 : a.source > b.source ? 1 : 0,
  );

  let linesScanned = 0;
  let recordsScanned = 0;
  const rawFindings: PrivacyReviewFinding[] = [];

  for (const segment of sortedSegments) {
    const lines = segment.content.split(/\r?\n/);
    for (let idx = 0; idx < lines.length; idx++) {
      const rawLine = lines[idx] ?? "";
      const trimmed = rawLine.trim();
      if (!trimmed) continue;

      linesScanned += 1;
      const lineNumber = idx + 1;

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        rawFindings.push({
          severity: "high",
          category: "malformed_record",
          ruleId: "malformed_json_line",
          source: segment.source,
          line: lineNumber,
          fieldPath: "$",
          message: "Malformed JSON record cannot be safely verified as shareable",
        });
        scanStringForFindings(
          trimmed,
          {
            source: segment.source,
            line: lineNumber,
            fieldPath: "$",
            knownSecrets,
            knownChatIds,
            flagPublicAccountAddresses,
          },
          rawFindings,
        );
        continue;
      }

      recordsScanned += 1;
      walkRecordForPrivacy(
        parsed,
        "$",
        null,
        {
          source: segment.source,
          line: lineNumber,
          knownSecrets,
          knownChatIds,
          flagPublicAccountAddresses,
        },
        rawFindings,
      );
    }
  }

  rawFindings.sort(compareFindings);

  // Deduplicate identical (source, line, fieldPath, category, ruleId) entries.
  const findings: PrivacyReviewFinding[] = [];
  const seenKeys = new Set<string>();
  for (const f of rawFindings) {
    const key = `${f.source}\0${f.line}\0${f.fieldPath}\0${f.category}\0${f.ruleId}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    findings.push(f);
  }

  const countsByCategory: Record<PrivacyFindingCategory, number> = {
    secret: 0,
    private_chat_id: 0,
    malformed_record: 0,
    public_address: 0,
  };
  const countsByRule: Record<string, number> = {};

  for (const f of findings) {
    countsByCategory[f.category] += 1;
    countsByRule[f.ruleId] = (countsByRule[f.ruleId] ?? 0) + 1;
  }

  const sortedRuleCounts: Record<string, number> = {};
  for (const ruleId of Object.keys(countsByRule).sort()) {
    sortedRuleCounts[ruleId] = countsByRule[ruleId] ?? 0;
  }

  return {
    format: "mimir-privacy-review-v1",
    shareable: findings.length === 0,
    filesScanned: sortedSegments.length,
    linesScanned,
    recordsScanned,
    findingCount: findings.length,
    countsByCategory,
    countsByRule: sortedRuleCounts,
    findings,
  };
}

/**
 * Offline privacy review for a JSONL event capture. Detects private chat/user
 * identifiers and secret-shaped values deterministically without network I/O
 * and without echoing raw sensitive values in findings.
 */
export function reviewScanJsonlPrivacy(
  jsonl: string,
  options: PrivacyReviewOptions = {},
): PrivacyReviewReport {
  const source = options.sourceName ?? "<jsonl>";
  return reviewPrivacySegments([{ source, content: jsonl }], options);
}

/**
 * Render a deterministic human-readable privacy review summary without
 * including raw secret or chat identifier values.
 */
export function formatPrivacyReviewReport(report: PrivacyReviewReport): string {
  const header = [
    `Privacy Review (${report.format}): ${report.shareable ? "SHAREABLE" : "BLOCKED"}`,
    `files=${report.filesScanned} lines=${report.linesScanned} records=${report.recordsScanned} findings=${report.findingCount}`,
  ];
  if (report.findings.length === 0) {
    return header.join("\n") + "\n";
  }
  const detailLines = report.findings.map(
    (f) =>
      `- [${f.severity.toUpperCase()}] ${f.category}/${f.ruleId} at ${f.source}:${f.line} (${f.fieldPath}) — ${f.message}`,
  );
  return [...header, ...detailLines].join("\n") + "\n";
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
