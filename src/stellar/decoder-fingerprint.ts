/**
 * Versioned semantic fingerprinting and drift detection for Soroban event decoders.
 *
 * ── Purpose ──────────────────────────────────────────────────────────────────
 *
 * Typed (`src/stellar/decode.ts`) and generic (`src/stellar/generic-decode.ts`)
 * decoders turn Soroban event payloads into notification-safe records.
 *
 * This module computes a versioned SHA-256 semantic fingerprint over canonical
 * decoded fields—independent of presentation text (rendered summaries,
 * diagnostic prose, key ordering, or omitted `undefined` properties)—and
 * reports breaking vs. non-breaking drift against reviewed fixture manifests.
 */

import { createHash } from "node:crypto";
import type { DecodedEvent } from "./decode.js";
import type { GenericDecodedEvent } from "./generic-decode.js";

/** Current semantic fingerprint algorithm & canonicalization schema version. */
export const DECODER_FINGERPRINT_VERSION = "v1" as const;

export type DecoderFingerprintVersion = typeof DECODER_FINGERPRINT_VERSION;

export type DecoderKind = "typed" | "generic";

export interface SemanticFingerprint {
  /** Schema version of the canonicalization and hashing algorithm. */
  version: DecoderFingerprintVersion;
  /** Which decoder produced the event ("typed" or "generic"). */
  kind: DecoderKind;
  /** Lowercase 64-char SHA-256 hex digest of the canonical payload. */
  hash: string;
  /** Version- and kind-prefixed fingerprint string, e.g. `v1:typed:<sha256>`. */
  fingerprint: string;
  /** Canonical, presentation-independent structure that was hashed. */
  canonical: Record<string, unknown>;
}

export interface FixtureFingerprintEntry {
  id: string;
  kind: DecoderKind;
  version: DecoderFingerprintVersion;
  fingerprint: string;
  hash: string;
  canonical: Record<string, unknown>;
}

export interface FixtureFingerprintManifest {
  schemaVersion: DecoderFingerprintVersion;
  generatedFrom: string;
  fixtures: Record<string, FixtureFingerprintEntry>;
}

export type FieldDriftKind = "added" | "removed" | "changed" | "type_changed";

export interface FieldDrift {
  path: string;
  kind: FieldDriftKind;
  expected?: unknown;
  actual?: unknown;
  breaking: boolean;
}

export type FixtureDriftStatus =
  | "unchanged"
  | "breaking"
  | "non_breaking"
  | "missing"
  | "added";

export interface FixtureDriftEntry {
  id: string;
  status: FixtureDriftStatus;
  expectedFingerprint?: string;
  actualFingerprint?: string;
  diffs: FieldDrift[];
}

export interface DriftReport {
  schemaVersion: DecoderFingerprintVersion;
  total: number;
  unchanged: number;
  breaking: number;
  nonBreaking: number;
  missing: number;
  added: number;
  hasBreakingChanges: boolean;
  entries: FixtureDriftEntry[];
}

// ── Canonicalization ─────────────────────────────────────────────────────────

/**
 * Convert any decoded value into a deterministic, JSON-serializable canonical
 * representation that preserves semantic types (e.g. `bigint` vs `number` vs
 * `string`, `Uint8Array` bytes) and sorts object keys lexicographically.
 */
export function canonicalizeValue(value: unknown): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : { $nonFinite: String(value) };
  }
  if (typeof value === "bigint") {
    return { $bigint: value.toString() };
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { $bytes: Buffer.from(value).toString("hex") };
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeValue(item));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    const keys = Object.keys(value as Record<string, unknown>).sort();
    for (const key of keys) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined) continue;
      out[key] = canonicalizeValue(v);
    }
    return out;
  }
  return String(value);
}

/**
 * Extract only the canonical semantic fields of a typed `DecodedEvent`.
 *
 * Diagnostic presentation text (`UnknownPayload.reason`) and any non-canonical
 * presentation properties are excluded so wording tweaks do not trigger drift.
 */
export function extractTypedCanonical(event: DecodedEvent): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    source: event.source,
    contractId: event.contractId,
    version: event.version,
    ledger: event.ledger,
    txHash: event.txHash,
    at: event.at,
    eventId: event.eventId,
    eventType: event.eventType,
    transactionIndex: event.transactionIndex,
    operationIndex: event.operationIndex,
    inSuccessfulContractCall: event.inSuccessfulContractCall,
  };

  const rawPayload = event.payload as unknown as Record<string, unknown>;
  const payload: Record<string, unknown> = {};
  for (const key of Object.keys(rawPayload).sort()) {
    // Diagnostic prose on unknown payloads is presentation text, not semantic data.
    if (rawPayload.name === "unknown" && key === "reason") continue;
    const val = rawPayload[key];
    if (val === undefined) continue;
    payload[key] = val;
  }

  return canonicalizeValue({ meta, payload }) as Record<string, unknown>;
}

/**
 * Extract only the canonical semantic fields of a `GenericDecodedEvent`.
 *
 * Derived presentation fields (`topicSummary`, `valueSummary`, `summary`,
 * `payload.summary`, `payload.reason`) are excluded so formatting changes do
 * not alter the semantic fingerprint.
 */
export function extractGenericCanonical(event: GenericDecodedEvent): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    source: event.source,
    contractId: event.contractId,
    ledger: event.ledger,
    txHash: event.txHash,
    at: event.at,
    eventId: event.eventId,
    eventType: event.eventType,
    transactionIndex: event.transactionIndex,
    operationIndex: event.operationIndex,
    inSuccessfulContractCall: event.inSuccessfulContractCall,
  };

  const payload: Record<string, unknown> = {
    name: "generic",
    eventName: event.eventName,
    topics: event.topics,
    value: event.value,
  };

  return canonicalizeValue({ meta, payload }) as Record<string, unknown>;
}

function buildFingerprint(
  kind: DecoderKind,
  canonical: Record<string, unknown>,
): SemanticFingerprint {
  const serialized = JSON.stringify({
    version: DECODER_FINGERPRINT_VERSION,
    kind,
    canonical,
  });
  const hash = createHash("sha256").update(serialized).digest("hex");
  return {
    version: DECODER_FINGERPRINT_VERSION,
    kind,
    hash,
    fingerprint: `${DECODER_FINGERPRINT_VERSION}:${kind}:${hash}`,
    canonical,
  };
}

/** Compute a versioned semantic fingerprint for a typed `DecodedEvent`. */
export function fingerprintDecodedEvent(event: DecodedEvent): SemanticFingerprint {
  return buildFingerprint("typed", extractTypedCanonical(event));
}

/** Compute a versioned semantic fingerprint for a `GenericDecodedEvent`. */
export function fingerprintGenericEvent(event: GenericDecodedEvent): SemanticFingerprint {
  return buildFingerprint("generic", extractGenericCanonical(event));
}

function isGenericDecodedEvent(
  event: DecodedEvent | GenericDecodedEvent,
): event is GenericDecodedEvent {
  return (
    typeof event === "object" &&
    event !== null &&
    "payload" in event &&
    typeof event.payload === "object" &&
    event.payload !== null &&
    (event.payload as { name?: unknown }).name === "generic"
  );
}

/** Compute a versioned semantic fingerprint for either a typed or generic decoded event. */
export function fingerprintDecoderOutput(
  event: DecodedEvent | GenericDecodedEvent,
): SemanticFingerprint {
  return isGenericDecodedEvent(event)
    ? fingerprintGenericEvent(event)
    : fingerprintDecodedEvent(event);
}

// ── Drift Detection & Breaking-Change Reporting ──────────────────────────────

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTypedTag(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && (keys[0] === "$bigint" || keys[0] === "$bytes" || keys[0] === "$nonFinite");
}

function canonicalTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (isTypedTag(value)) return Object.keys(value as Record<string, unknown>)[0] ?? "object";
  return typeof value;
}

function diffCanonical(
  expected: unknown,
  actual: unknown,
  path: string,
  diffs: FieldDrift[],
): void {
  const expType = canonicalTypeOf(expected);
  const actType = canonicalTypeOf(actual);

  if (expType !== actType) {
    diffs.push({
      path,
      kind: "type_changed",
      expected,
      actual,
      breaking: true,
    });
    return;
  }

  if (Array.isArray(expected) && Array.isArray(actual)) {
    const maxLen = Math.max(expected.length, actual.length);
    for (let i = 0; i < maxLen; i += 1) {
      const itemPath = `${path}[${i}]`;
      if (i >= actual.length) {
        diffs.push({ path: itemPath, kind: "removed", expected: expected[i], breaking: true });
      } else if (i >= expected.length) {
        diffs.push({ path: itemPath, kind: "added", actual: actual[i], breaking: false });
      } else {
        diffCanonical(expected[i], actual[i], itemPath, diffs);
      }
    }
    return;
  }

  if (isPlainRecord(expected) && isPlainRecord(actual) && !isTypedTag(expected)) {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of [...keys].sort()) {
      const childPath = path ? `${path}.${key}` : key;
      const inExp = Object.prototype.hasOwnProperty.call(expected, key);
      const inAct = Object.prototype.hasOwnProperty.call(actual, key);
      if (inExp && !inAct) {
        diffs.push({ path: childPath, kind: "removed", expected: expected[key], breaking: true });
      } else if (!inExp && inAct) {
        diffs.push({ path: childPath, kind: "added", actual: actual[key], breaking: false });
      } else {
        diffCanonical(expected[key], actual[key], childPath, diffs);
      }
    }
    return;
  }

  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    diffs.push({
      path,
      kind: "changed",
      expected,
      actual,
      breaking: true,
    });
  }
}

/**
 * Build a `FixtureFingerprintManifest` from a map of fixture IDs to computed
 * semantic fingerprints.
 */
export function createFixtureManifest(
  fingerprints: Record<string, SemanticFingerprint>,
  generatedFrom: string = "tests/fixtures/events.mjs",
): FixtureFingerprintManifest {
  const fixtures: Record<string, FixtureFingerprintEntry> = {};
  for (const id of Object.keys(fingerprints).sort()) {
    const fp = fingerprints[id];
    if (!fp) continue;
    fixtures[id] = {
      id,
      kind: fp.kind,
      version: fp.version,
      fingerprint: fp.fingerprint,
      hash: fp.hash,
      canonical: fp.canonical,
    };
  }
  return {
    schemaVersion: DECODER_FINGERPRINT_VERSION,
    generatedFrom,
    fixtures,
  };
}

/**
 * Compare current decoder fingerprints against a reviewed fixture manifest
 * and classify every change as unchanged, non-breaking (additive), breaking,
 * missing, or added.
 */
export function compareFixtureFingerprints(
  baseline: FixtureFingerprintManifest,
  actual: Record<string, SemanticFingerprint>,
): DriftReport {
  const allIds = new Set([
    ...Object.keys(baseline.fixtures),
    ...Object.keys(actual),
  ]);

  const entries: FixtureDriftEntry[] = [];
  let unchanged = 0;
  let breaking = 0;
  let nonBreaking = 0;
  let missing = 0;
  let added = 0;

  for (const id of [...allIds].sort()) {
    const exp = baseline.fixtures[id];
    const act = actual[id];

    if (exp && !act) {
      missing += 1;
      entries.push({
        id,
        status: "missing",
        expectedFingerprint: exp.fingerprint,
        diffs: [{ path: "$fixture", kind: "removed", expected: exp.fingerprint, breaking: true }],
      });
      continue;
    }

    if (!exp && act) {
      added += 1;
      entries.push({
        id,
        status: "added",
        actualFingerprint: act.fingerprint,
        diffs: [{ path: "$fixture", kind: "added", actual: act.fingerprint, breaking: false }],
      });
      continue;
    }

    if (!exp || !act) continue;

    if (exp.fingerprint === act.fingerprint) {
      unchanged += 1;
      entries.push({
        id,
        status: "unchanged",
        expectedFingerprint: exp.fingerprint,
        actualFingerprint: act.fingerprint,
        diffs: [],
      });
      continue;
    }

    const diffs: FieldDrift[] = [];
    if (exp.version !== act.version) {
      diffs.push({
        path: "$version",
        kind: "changed",
        expected: exp.version,
        actual: act.version,
        breaking: true,
      });
    }
    if (exp.kind !== act.kind) {
      diffs.push({
        path: "$kind",
        kind: "changed",
        expected: exp.kind,
        actual: act.kind,
        breaking: true,
      });
    }
    diffCanonical(exp.canonical, act.canonical, "", diffs);

    const isBreaking = diffs.some((d) => d.breaking) || diffs.length === 0;
    if (isBreaking) {
      breaking += 1;
    } else {
      nonBreaking += 1;
    }

    entries.push({
      id,
      status: isBreaking ? "breaking" : "non_breaking",
      expectedFingerprint: exp.fingerprint,
      actualFingerprint: act.fingerprint,
      diffs,
    });
  }

  return {
    schemaVersion: DECODER_FINGERPRINT_VERSION,
    total: entries.length,
    unchanged,
    breaking,
    nonBreaking,
    missing,
    added,
    hasBreakingChanges: breaking > 0 || missing > 0,
    entries,
  };
}

/** Format a `DriftReport` as a concise human-readable summary for CI and PR logs. */
export function formatDriftReport(report: DriftReport): string {
  const lines: string[] = [
    `Decoder semantic fingerprint report (${report.schemaVersion}): ` +
      `${report.unchanged}/${report.total} unchanged, ` +
      `${report.breaking} breaking, ${report.missing} missing, ` +
      `${report.nonBreaking} non-breaking, ${report.added} added`,
  ];

  for (const entry of report.entries) {
    if (entry.status === "unchanged") continue;
    lines.push(`- [${entry.status.toUpperCase()}] ${entry.id}`);
    if (entry.expectedFingerprint && entry.actualFingerprint) {
      lines.push(`    expected: ${entry.expectedFingerprint}`);
      lines.push(`    actual:   ${entry.actualFingerprint}`);
    }
    for (const diff of entry.diffs) {
      const severity = diff.breaking ? "BREAKING" : "NON-BREAKING";
      lines.push(
        `    ${severity} ${diff.kind} at ${diff.path || "<root>"}` +
          (diff.expected !== undefined ? ` (expected=${JSON.stringify(diff.expected)})` : "") +
          (diff.actual !== undefined ? ` (actual=${JSON.stringify(diff.actual)})` : ""),
      );
    }
  }

  return lines.join("\n");
}
