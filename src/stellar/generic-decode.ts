/**
 * Generic Soroban contract event decoder with bounded, sanitized rendering and type tags.
 *
 * ── Purpose ──────────────────────────────────────────────────────────────────
 *
 * `decodeEvent` in `src/stellar/decode.ts` only knows the mimir-market and mimir-squad
 * schemas. Partners and testers need to watch related contracts (e.g. a token or a
 * new Mimir module) without authoring a dedicated decoder first.
 *
 * ── Invariants ───────────────────────────────────────────────────────────────
 *
 * 1. NEVER throws on malformed XDR, unknown discriminators, or hostile payloads.
 * 2. Every ScVal type maps to a stable, unambiguous textual representation with a type tag.
 * 3. Hostile nesting (deep maps/vectors, excessive keys, oversized strings/bytes) is strictly bounded.
 * 4. Strings are sanitized to prevent newline/control character injection in logs/chat.
 * 5. Large integers are represented as decimal strings; lossy/unsafe numbers (> MAX_SAFE_INTEGER, non-finite) render as malformed.
 */

import { scValToNative, type rpc, type xdr } from "@stellar/stellar-sdk";
import type { EventQuarantine } from "./quarantine.js";

// ── Bounded Limits ───────────────────────────────────────────────────────────

/** Maximum recursion depth for nested vectors and maps. */
export const MAX_GENERIC_DEPTH = 5;

/** Maximum number of keys rendered in a single map before truncation. */
export const MAX_GENERIC_KEYS = 20;

/** Maximum number of elements rendered in a single vector before truncation. */
export const MAX_GENERIC_VEC_ITEMS = 20;

/** Maximum character length of any rendered string or symbol before clipping. */
export const MAX_GENERIC_STRING_CHARS = 120;

/** Maximum hex character length of any rendered bytes buffer before clipping. */
export const MAX_GENERIC_BYTES_CHARS = 64;

/** Hard ceiling on total rendered string representation. */
export const MAX_GENERIC_TOTAL_CHARS = 2048;

/** Maximum number of topics allowed on a single Soroban event (protocol max is 4). */
export const MAX_GENERIC_TOPICS = 4;

export interface GenericRenderOptions {
  maxDepth?: number;
  maxKeys?: number;
  maxVecItems?: number;
  maxStringChars?: number;
  maxBytesChars?: number;
  /**
   * Optional quarantine instance to preserve undecodable event envelopes.
   * When provided and an event cannot be decoded cleanly (e.g. malformed XDR or unknown payload),
   * the raw envelope and source identity are preserved to the quarantine.
   */
  quarantine?: EventQuarantine;
}

export interface GenericEventPayload {
  name: "generic" | "unknown";
  eventName: string;
  topics: string[];
  value: string;
  summary: string;
  reason?: string;
  /** Distinguishes an unrecognized event name from a malformed known event. */
  status?: "ok" | "unknown_event" | "malformed_event";
}

export interface GenericDecodedEvent {
  source: string;
  contractId: string;
  ledger: number;
  txHash: string;
  at: number;
  eventId: string;
  eventType: string;
  transactionIndex: number | null;
  operationIndex: number | null;
  inSuccessfulContractCall: boolean | null;
  eventName: string;
  topics: string[];
  value: string;
  topicSummary: string;
  valueSummary: string;
  summary: string;
  payload: GenericEventPayload;
  /** Stable status code: `ok`, `unknown_event`, or `malformed_event`. */
  status: "ok" | "unknown_event" | "malformed_event";
  /** Human-readable reason when `status` is not `ok`. */
  reason?: string;
}

// ── String Sanitization & Clipping ───────────────────────────────────────────

function sanitizeText(str: string): string {
  return str.replace(/[\r\n\t\x00-\x1f\x7f]+/g, " ").trim();
}

function clipString(str: string, max: number = MAX_GENERIC_STRING_CHARS): string {
  const sanitized = sanitizeText(str);
  const chars = Array.from(sanitized);
  return chars.length <= max ? sanitized : `${chars.slice(0, max - 1).join("")}…`;
}

function clipBytesHex(hex: string, max: number = MAX_GENERIC_BYTES_CHARS): string {
  return hex.length <= max ? hex : `${hex.slice(0, max)}…`;
}

// ── ScVal Detection Helpers ──────────────────────────────────────────────────

// `@stellar/stellar-sdk` 17 (#527) replaced the union accessors: an ScVal now
// carries its arm name as a `type` string and its payload as a `value` getter,
// where 16 exposed `switch()` and `value()` methods. Both shapes are accepted
// so hand-built ScVal-like objects keep rendering the same way.

function isScValLike(val: unknown): val is xdr.ScVal {
  if (val === null || typeof val !== "object") return false;
  const v = val as { switch?: unknown; type?: unknown };
  if (typeof v.switch === "function") return true;
  return typeof v.type === "string" && v.type.startsWith("scv") && "value" in val;
}

/** The ScVal arm name (`scvBool`, `scvVec`, …). Throws on a malformed value. */
function scValSwitchName(val: xdr.ScVal): string {
  const v = val as unknown as { switch?: () => unknown; type?: unknown };
  if (typeof v.switch === "function") {
    const sw = v.switch();
    return typeof sw === "object" && sw !== null && "name" in sw
      ? String((sw as { name: unknown }).name)
      : String(sw);
  }
  if (typeof v.type === "string") return v.type;
  throw new TypeError("ScVal has no discriminator");
}

/** The ScVal payload: the `value` getter (SDK 17) or `value()` method (SDK 16). */
function scValPayload(val: xdr.ScVal): unknown {
  const raw = (val as unknown as { value?: unknown }).value;
  return typeof raw === "function" ? (raw as () => unknown).call(val) : raw;
}

// ── Duplicate Map Key Detection ──────────────────────────────────────────────

function boundDiagnostic(message: string, maxLen: number = MAX_GENERIC_DIAGNOSTIC_LENGTH): string {
  const compact = sanitizeText(message) || "unknown error";
  const chars = Array.from(compact);
  return chars.length <= maxLen ? compact : `${chars.slice(0, maxLen - 1).join("")}…`;
}

function normalizeMapKey(kVal: unknown): string | null {
  if (kVal === null || kVal === undefined) return "undefined";
  if (isScValLike(kVal)) {
    let switchName = "";
    try {
      switchName = scValSwitchName(kVal);
    } catch {
      return null;
    }
    if (switchName === "scvVoid") return "undefined";
    if (switchName === "scvMap" || switchName === "scvVec") {
      try {
        const toXdr = (kVal as unknown as { toXDR?: (format?: string) => unknown }).toXDR;
        if (typeof toXdr === "function") {
          const encoded = toXdr.call(kVal, "base64");
          if (typeof encoded === "string") return `xdr:${encoded}`;
          if (Buffer.isBuffer(encoded) || encoded instanceof Uint8Array) {
            return `xdr:${Buffer.from(encoded).toString("base64")}`;
          }
        }
      } catch {
        // fall through to generic renderer
      }
      return renderGenericScVal(kVal, 0);
    }
    try {
      const native = scValToNative(kVal);
      if (Buffer.isBuffer(native) || native instanceof Uint8Array) {
        return Buffer.from(native).toString("utf8");
      }
      return String(native);
    } catch {
      return null;
    }
  }
  if (Buffer.isBuffer(kVal) || kVal instanceof Uint8Array) {
    return Buffer.from(kVal).toString("utf8");
  }
  return String(kVal);
}

/**
 * Inspect an ScVal (or native Map/array/object) for conflicting duplicate map
 * keys BEFORE conversion to JavaScript objects.
 *
 * Returns a bounded diagnostic on the first collision found, or `null` if no
 * duplicate map keys exist within `maxDepth`.
 */
export function findDuplicateMapKey(
  val: unknown,
  maxDepth: number = MAX_GENERIC_DEPTH,
  depth: number = 0,
  visited: WeakSet<object> = new WeakSet(),
): DuplicateMapKeyCollision | null {
  if (val === null || val === undefined || typeof val !== "object") return null;
  if (depth >= maxDepth) return null;
  if (visited.has(val)) return null;
  visited.add(val);

  if (isScValLike(val)) {
    let switchName = "";
    try {
      switchName = scValSwitchName(val);
    } catch {
      return null;
    }

    if (switchName === "scvVec") {
      try {
        const rawItems = scValPayload(val);
        if (Array.isArray(rawItems)) {
          for (const item of rawItems) {
            const collision = findDuplicateMapKey(item, maxDepth, depth + 1, visited);
            if (collision) return collision;
          }
        }
      } catch {
        return null;
      }
      return null;
    }

    if (switchName === "scvMap") {
      try {
        const rawEntries = scValPayload(val);
        if (!Array.isArray(rawEntries)) return null;
        const seen = new Set<string>();
        for (const entry of rawEntries) {
          const e = entry as { key?: () => unknown; val?: () => unknown };
          const kVal = typeof e.key === "function" ? e.key() : (entry as { key?: unknown }).key;
          const vVal = typeof e.val === "function" ? e.val() : (entry as { val?: unknown }).val;

          const keyCollision = findDuplicateMapKey(kVal, maxDepth, depth + 1, visited);
          if (keyCollision) return keyCollision;

          const normalizedKey = normalizeMapKey(kVal);
          if (normalizedKey !== null) {
            if (seen.has(normalizedKey)) {
              const clippedKey = clipString(normalizedKey, 60);
              return {
                key: clippedKey,
                reason: boundDiagnostic(`duplicate map key collision: "${clippedKey}"`),
              };
            }
            seen.add(normalizedKey);
          }

          const valCollision = findDuplicateMapKey(vVal, maxDepth, depth + 1, visited);
          if (valCollision) return valCollision;
        }
      } catch {
        return null;
      }
      return null;
    }

    return null;
  }

  if (val instanceof Map) {
    const seen = new Set<string>();
    for (const [k, v] of val.entries()) {
      const keyCollision = findDuplicateMapKey(k, maxDepth, depth + 1, visited);
      if (keyCollision) return keyCollision;

      const normalizedKey = normalizeMapKey(k);
      if (normalizedKey !== null) {
        if (seen.has(normalizedKey)) {
          const clippedKey = clipString(normalizedKey, 60);
          return {
            key: clippedKey,
            reason: boundDiagnostic(`duplicate map key collision: "${clippedKey}"`),
          };
        }
        seen.add(normalizedKey);
      }

      const valCollision = findDuplicateMapKey(v, maxDepth, depth + 1, visited);
      if (valCollision) return valCollision;
    }
    return null;
  }

  if (Array.isArray(val)) {
    for (const item of val) {
      const collision = findDuplicateMapKey(item, maxDepth, depth + 1, visited);
      if (collision) return collision;
    }
    return null;
  }

  for (const v of Object.values(val)) {
    const collision = findDuplicateMapKey(v, maxDepth, depth + 1, visited);
    if (collision) return collision;
  }
  return null;
}

// ── Recursive Renderer ───────────────────────────────────────────────────────

/**
 * Render any ScVal (or native value) into a bounded, sanitized textual summary
 * with explicit type tags. Never throws on malformed XDR or invalid discriminators.
 */
export function renderGenericScVal(
  val: unknown,
  depth: number = 0,
  options?: GenericRenderOptions,
  visited: WeakSet<object> = new WeakSet(),
): string {
  try {
    const maxDepth = options?.maxDepth ?? MAX_GENERIC_DEPTH;
    const maxKeys = options?.maxKeys ?? MAX_GENERIC_KEYS;
    const maxVecItems = options?.maxVecItems ?? MAX_GENERIC_VEC_ITEMS;
    const maxStringChars = options?.maxStringChars ?? MAX_GENERIC_STRING_CHARS;
    const maxBytesChars = options?.maxBytesChars ?? MAX_GENERIC_BYTES_CHARS;

    // Handle null / undefined
    if (val === null || val === undefined) {
      return "void";
    }

    // Handle xdr.ScVal instances
    if (isScValLike(val)) {
      return renderScValInstance(val, depth, maxDepth, maxKeys, maxVecItems, maxStringChars, maxBytesChars, options, visited);
    }

    // Handle native JS values (primitives, buffers, arrays, objects)
    return renderNativeValue(val, depth, maxDepth, maxKeys, maxVecItems, maxStringChars, maxBytesChars, options, visited);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `malformed:${clipString(msg, 60)}`;
  }
}

/** Alias of `renderGenericScVal` */
export const renderScVal = renderGenericScVal;

function renderIntegerNative(native: unknown, typeName: string): string {
  if (typeof native === "bigint") {
    return `${typeName}:${native.toString(10)}`;
  }
  if (typeof native === "number") {
    if (!Number.isSafeInteger(native)) {
      return `${typeName}:malformed`;
    }
    return `${typeName}:${native}`;
  }
  if (typeof native === "string" && /^-?\d+$/.test(native.trim())) {
    return `${typeName}:${native.trim()}`;
  }
  return `${typeName}:malformed`;
}

function renderScValInstance(
  val: xdr.ScVal,
  depth: number,
  maxDepth: number,
  maxKeys: number,
  maxVecItems: number,
  maxStringChars: number,
  maxBytesChars: number,
  options: GenericRenderOptions | undefined,
  visited: WeakSet<object>,
): string {
  let switchName = "";
  try {
    switchName = scValSwitchName(val);
  } catch {
    return "malformed";
  }

  // Guard against circular structures in exotic objects
  if (typeof val === "object" && val !== null) {
    if (visited.has(val)) return "[circular]";
    visited.add(val);
  }

  switch (switchName) {
    case "scvBool": {
      try {
        const native = scValToNative(val);
        return `bool:${native}`;
      } catch {
        return "bool:unknown";
      }
    }

    case "scvVoid":
      return "void";

    case "scvU32": {
      try {
        const native = scValToNative(val);
        return renderIntegerNative(native, "u32");
      } catch {
        return "u32:malformed";
      }
    }

    case "scvI32": {
      try {
        const native = scValToNative(val);
        return renderIntegerNative(native, "i32");
      } catch {
        return "i32:malformed";
      }
    }

    case "scvU64": {
      try {
        const native = scValToNative(val);
        return renderIntegerNative(native, "u64");
      } catch {
        return "u64:malformed";
      }
    }

    case "scvI64": {
      try {
        const native = scValToNative(val);
        return renderIntegerNative(native, "i64");
      } catch {
        return "i64:malformed";
      }
    }

    case "scvTimepoint": {
      try {
        const native = scValToNative(val);
        return renderIntegerNative(native, "timepoint");
      } catch {
        return "timepoint:malformed";
      }
    }

    case "scvDuration": {
      try {
        const native = scValToNative(val);
        return renderIntegerNative(native, "duration");
      } catch {
        return "duration:malformed";
      }
    }

    case "scvU128": {
      try {
        const native = scValToNative(val);
        return renderIntegerNative(native, "u128");
      } catch {
        return "u128:malformed";
      }
    }

    case "scvI128": {
      try {
        const native = scValToNative(val);
        return renderIntegerNative(native, "i128");
      } catch {
        return "i128:malformed";
      }
    }

    case "scvU256": {
      try {
        const native = scValToNative(val);
        return renderIntegerNative(native, "u256");
      } catch {
        return "u256:malformed";
      }
    }

    case "scvI256": {
      try {
        const native = scValToNative(val);
        return renderIntegerNative(native, "i256");
      } catch {
        return "i256:malformed";
      }
    }

    case "scvBytes": {
      try {
        const native = scValToNative(val);
        const buf = Buffer.isBuffer(native) ? native : Buffer.from(native as Uint8Array);
        const hex = buf.toString("hex");
        return `bytes:${clipBytesHex(hex, maxBytesChars)}`;
      } catch {
        return "bytes:malformed";
      }
    }

    case "scvString": {
      try {
        const native = scValToNative(val);
        return `string:"${clipString(String(native), maxStringChars)}"`;
      } catch {
        return "string:malformed";
      }
    }

    case "scvSymbol": {
      try {
        const native = scValToNative(val);
        return `symbol:${clipString(String(native), maxStringChars)}`;
      } catch {
        return "symbol:malformed";
      }
    }

    case "scvAddress": {
      try {
        const native = scValToNative(val);
        return `address:${clipString(String(native), 56)}`;
      } catch {
        return "address:malformed";
      }
    }

    case "scvVec": {
      if (depth >= maxDepth) {
        return "vec:[...]";
      }
      try {
        const rawItems = scValPayload(val);
        if (!Array.isArray(rawItems)) {
          // Fallback via scValToNative if value() is absent
          const native = scValToNative(val);
          if (Array.isArray(native)) {
            return renderNativeArray(native, depth, maxDepth, maxVecItems, options, visited);
          }
          return "vec:[]";
        }

        const count = rawItems.length;
        const slice = rawItems.slice(0, maxVecItems);
        const rendered = slice.map((item) =>
          renderGenericScVal(item, depth + 1, options, visited),
        );
        if (count > maxVecItems) {
          rendered.push(`… (+${count - maxVecItems} more)`);
        }
        return `vec:[${rendered.join(", ")}]`;
      } catch (err) {
        return `vec:malformed(${err instanceof Error ? err.message : String(err)})`;
      }
    }

    case "scvMap": {
      if (depth >= maxDepth) {
        return "map:{...}";
      }
      try {
        const collision = findDuplicateMapKey(val, maxDepth - depth);
        if (collision) {
          return `map:malformed(${collision.reason})`;
        }
        const rawEntries = scValPayload(val);
        if (!Array.isArray(rawEntries)) {
          const native = scValToNative(val);
          if (native && typeof native === "object") {
            return renderNativeObject(native, depth, maxDepth, maxKeys, options, visited);
          }
          return "map:{}";
        }

        const count = rawEntries.length;
        const slice = rawEntries.slice(0, maxKeys);
        const rendered: string[] = [];

        for (const entry of slice) {
          const e = entry as { key?: () => unknown; val?: () => unknown };
          const kVal = typeof e.key === "function" ? e.key() : (entry as { key?: unknown }).key;
          const vVal = typeof e.val === "function" ? e.val() : (entry as { val?: unknown }).val;

          const renderedKey = renderGenericScVal(kVal, depth + 1, options, visited);
          const renderedVal = renderGenericScVal(vVal, depth + 1, options, visited);
          rendered.push(`${renderedKey}: ${renderedVal}`);
        }

        if (count > maxKeys) {
          rendered.push(`… (+${count - maxKeys} more)`);
        }
        return `map:{${rendered.join(", ")}}`;
      } catch (err) {
        return `map:malformed(${err instanceof Error ? err.message : String(err)})`;
      }
    }

    case "scvError": {
      try {
        const native = scValToNative(val) as { type?: unknown; code?: unknown } | null;
        if (native && typeof native === "object") {
          return `error:${native.type ?? "unknown"}:${native.code ?? ""}`;
        }
        return "error";
      } catch {
        return "error:malformed";
      }
    }

    case "scvContractInstance":
      return "contract_instance";

    case "scvLedgerKeyContractInstance":
      return "contract_instance_key";

    case "scvLedgerKeyNonce":
      return "nonce_key";

    default:
      return `${switchName || "unknown"}`;
  }
}

function renderNativeValue(
  val: unknown,
  depth: number,
  maxDepth: number,
  maxKeys: number,
  maxVecItems: number,
  maxStringChars: number,
  maxBytesChars: number,
  options: GenericRenderOptions | undefined,
  visited: WeakSet<object>,
): string {
  if (typeof val === "boolean") {
    return `bool:${val}`;
  }

  if (typeof val === "number") {
    if (!Number.isFinite(val) || (Number.isInteger(val) && !Number.isSafeInteger(val))) {
      return "number:malformed";
    }
    return `number:${val}`;
  }

  if (typeof val === "bigint") {
    return `bigint:${val.toString(10)}`;
  }

  if (typeof val === "string") {
    if (/^[GC][A-Z2-7]{55}$/.test(val)) {
      return `address:${val}`;
    }
    return `string:"${clipString(val, maxStringChars)}"`;
  }

  if (Buffer.isBuffer(val) || val instanceof Uint8Array) {
    const hex = Buffer.from(val).toString("hex");
    return `bytes:${clipBytesHex(hex, maxBytesChars)}`;
  }

  if (Array.isArray(val)) {
    return renderNativeArray(val, depth, maxDepth, maxVecItems, options, visited);
  }

  if (typeof val === "object" && val !== null) {
    return renderNativeObject(val, depth, maxDepth, maxKeys, options, visited);
  }

  return clipString(String(val), maxStringChars);
}

function renderNativeArray(
  arr: unknown[],
  depth: number,
  maxDepth: number,
  maxVecItems: number,
  options: GenericRenderOptions | undefined,
  visited: WeakSet<object>,
): string {
  if (depth >= maxDepth) return "vec:[...]";
  if (visited.has(arr)) return "[circular]";
  visited.add(arr);

  const count = arr.length;
  const slice = arr.slice(0, maxVecItems);
  const items = slice.map((item) => renderGenericScVal(item, depth + 1, options, visited));
  if (count > maxVecItems) {
    items.push(`… (+${count - maxVecItems} more)`);
  }
  return `vec:[${items.join(", ")}]`;
}

function renderNativeObject(
  obj: object,
  depth: number,
  maxDepth: number,
  maxKeys: number,
  options: GenericRenderOptions | undefined,
  visited: WeakSet<object>,
): string {
  if (depth >= maxDepth) return "map:{...}";
  if (visited.has(obj)) return "[circular]";
  visited.add(obj);

  // Handle Map instances
  if (obj instanceof Map) {
    const entries = Array.from(obj.entries());
    const count = entries.length;
    const slice = entries.slice(0, maxKeys);
    const rendered = slice.map(([k, v]) => {
      const rk = renderGenericScVal(k, depth + 1, options, visited);
      const rv = renderGenericScVal(v, depth + 1, options, visited);
      return `${rk}: ${rv}`;
    });
    if (count > maxKeys) {
      rendered.push(`… (+${count - maxKeys} more)`);
    }
    return `map:{${rendered.join(", ")}}`;
  }

  const entries = Object.entries(obj);
  const count = entries.length;
  const slice = entries.slice(0, maxKeys);
  const rendered = slice.map(([k, v]) => {
    const rv = renderGenericScVal(v, depth + 1, options, visited);
    return `${sanitizeText(k)}: ${rv}`;
  });
  if (count > maxKeys) {
    rendered.push(`… (+${count - maxKeys} more)`);
  }
  return `map:{${rendered.join(", ")}}`;
}

// ── Topics & Event Decoding ──────────────────────────────────────────────────

/**
 * Render an array of topics safely.
 */
export function renderTopics(
  topics: unknown[] | undefined | null,
  options?: GenericRenderOptions,
): string[] {
  if (!Array.isArray(topics)) return [];
  return topics.map((t) => renderGenericScVal(t, 0, options));
}

function toLedger(value: unknown): number {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) return 0;
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    try {
      const bn = BigInt(value.trim());
      if (bn < 0n || bn > BigInt(Number.MAX_SAFE_INTEGER)) return 0;
      return Number(bn);
    } catch {
      return 0;
    }
  }
  return 0;
}

function toPosition(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    try {
      const bn = BigInt(value.trim());
      if (bn < 0n || bn > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      return Number(bn);
    } catch {
      return null;
    }
  }
  return null;
}

function toTxHash(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function toAt(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0;
  const ms = new Date(value as string).getTime();
  if (!Number.isFinite(ms)) return 0;
  return Math.floor(ms / 1000);
}

function extractEventName(firstTopic: unknown): string {
  if (typeof firstTopic === "string") return sanitizeText(firstTopic);
  if (Buffer.isBuffer(firstTopic) || firstTopic instanceof Uint8Array) {
    return sanitizeText(Buffer.from(firstTopic).toString("utf8"));
  }
  if (isScValLike(firstTopic)) {
    try {
      const native = scValToNative(firstTopic);
      if (typeof native === "string") return sanitizeText(native);
      if (Buffer.isBuffer(native) || native instanceof Uint8Array) {
        return sanitizeText(Buffer.from(native).toString("utf8"));
      }
    } catch {
      return "unknown";
    }
  }
  return "unknown";
}

/**
 * Classify the decoded event name.
 *
 * - `unknown_event`: the first topic is absent or does not yield a usable name.
 * - `malformed_event`: the first topic looks like a known event name but the
 *   payload could not be rendered (e.g. the value rendered as `malformed`).
 * - `ok`: a usable event name was extracted and the payload rendered cleanly.
 */
function classifyEventStatus(
  eventName: string,
  value: string,
): { status: "ok" | "unknown_event" | "malformed_event"; reason?: string } {
  if (eventName === "unknown" || eventName === "") {
    return { status: "unknown_event", reason: "unrecognized event name" };
  }
  if (eventName.startsWith("malformed")) {
    return { status: "malformed_event", reason: "malformed known event name" };
  }
  if (value === "malformed" || value.startsWith("malformed:")) {
    return { status: "malformed_event", reason: "malformed known event payload" };
  }
  return { status: "ok" };
}

/**
 * Decode any Soroban event into a bounded GenericDecodedEvent.
 *
 * Never throws on malformed XDR, null fields, or oversized payloads.
 */
export function decodeGenericEvent(
  rawEvent: unknown,
  source: string = "generic",
  options?: GenericRenderOptions,
): GenericDecodedEvent {
  const event = (rawEvent ?? {}) as Partial<rpc.Api.EventResponse> & Record<string, unknown>;

  const rawContractId = (event as Record<string, unknown>).contractId;
  const contractId = typeof rawContractId === "string" ? rawContractId.trim() : "";
  const ledger = toLedger(event.ledger);
  const txHash = toTxHash(event.txHash);
  const at = toAt(event.ledgerClosedAt);
  const eventId = typeof event.id === "string" ? event.id : "";
  const eventType = typeof event.type === "string" ? event.type : "unknown";
  const transactionIndex = toPosition(event.transactionIndex);
  const operationIndex = toPosition(event.operationIndex);
  const inSuccessfulContractCall =
    typeof event.inSuccessfulContractCall === "boolean" ? event.inSuccessfulContractCall : null;

  const maxTopics = options?.maxTopics ?? MAX_GENERIC_TOPICS;
  const hasTopicArray =
    Array.isArray(event.topic) || Array.isArray((event as { topics?: unknown }).topics);
  const rawTopics = Array.isArray(event.topic)
    ? event.topic
    : Array.isArray((event as { topics?: unknown }).topics)
      ? (event as { topics: unknown[] }).topics
      : [];

  // Validate topic count before accessing variant positions or parsing payload.
  if (!hasTopicArray || rawTopics.length === 0 || rawTopics.length > maxTopics) {
    const reason = !hasTopicArray
      ? "missing or invalid topic array"
      : rawTopics.length === 0
        ? "empty topic array"
        : `topic count ${rawTopics.length} exceeds maximum of ${maxTopics}`;
    const summary = `[unknown] (malformed: ${reason})`;
    return {
      source,
      contractId,
      ledger,
      txHash,
      at,
      eventId,
      eventType,
      transactionIndex,
      operationIndex,
      inSuccessfulContractCall,
      eventName: "unknown",
      topics: [],
      value: "void",
      topicSummary: "(none)",
      valueSummary: "void",
      summary,
      payload: {
        name: "generic",
        eventName: "unknown",
        topics: [],
        value: "void",
        summary,
        reason,
      },
    };
  }

  const eventName = extractEventName(rawTopics[0]);
  const topics = renderTopics(rawTopics, options);
  const value = renderGenericScVal(event.value, 0, options);

  if (options?.quarantine) {
    const isUndecodable =
      eventName === "unknown" ||
      rawTopics.length === 0 ||
      topics.some((t) => t === "malformed") ||
      value === "malformed";
    if (isUndecodable) {
      const reason =
        eventName === "unknown"
          ? "unrecognized event name"
          : value === "malformed"
            ? "malformed value"
            : "malformed topics";
      void options.quarantine.quarantine(event, source, reason).catch(() => {});
    }
  }

  const topicSummary = topics.length > 0 ? topics.join(" | ") : "(none)";
  const valueSummary = value;
  const summary = `[${eventName}] ${topicSummary} => ${valueSummary}`;
  const { status, reason } = classifyEventStatus(eventName, value);

  return {
    source,
    contractId,
    ledger,
    txHash,
    at,
    eventId,
    eventType,
    transactionIndex,
    operationIndex,
    inSuccessfulContractCall,
    eventName,
    topics,
    value,
    topicSummary,
    valueSummary,
    summary,
    status,
    reason,
    payload: {
      name: "generic",
      eventName,
      topics,
      value,
      summary,
      status,
      reason,
    },
  };
}

export {
  DECODER_FINGERPRINT_VERSION,
  fingerprintGenericEvent,
  fingerprintDecoderOutput,
  type SemanticFingerprint,
} from "./decoder-fingerprint.js";
