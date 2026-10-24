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
 */

import { scValToNative, type rpc, type xdr } from "@stellar/stellar-sdk";

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

export interface GenericRenderOptions {
  maxDepth?: number;
  maxKeys?: number;
  maxVecItems?: number;
  maxStringChars?: number;
  maxBytesChars?: number;
}

export interface GenericEventPayload {
  name: "generic";
  eventName: string;
  topics: string[];
  value: string;
  summary: string;
  reason?: string;
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

function isScValLike(val: unknown): val is xdr.ScVal {
  return (
    val !== null &&
    typeof val === "object" &&
    typeof (val as { switch?: unknown }).switch === "function"
  );
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
    const sw = val.switch();
    switchName = typeof sw === "object" && sw !== null && "name" in sw ? String(sw.name) : String(sw);
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
        return `u32:${native}`;
      } catch {
        return "u32:malformed";
      }
    }

    case "scvI32": {
      try {
        const native = scValToNative(val);
        return `i32:${native}`;
      } catch {
        return "i32:malformed";
      }
    }

    case "scvU64": {
      try {
        const native = scValToNative(val);
        return `u64:${native}`;
      } catch {
        return "u64:malformed";
      }
    }

    case "scvI64": {
      try {
        const native = scValToNative(val);
        return `i64:${native}`;
      } catch {
        return "i64:malformed";
      }
    }

    case "scvTimepoint": {
      try {
        const native = scValToNative(val);
        return `timepoint:${native}`;
      } catch {
        return "timepoint:malformed";
      }
    }

    case "scvDuration": {
      try {
        const native = scValToNative(val);
        return `duration:${native}`;
      } catch {
        return "duration:malformed";
      }
    }

    case "scvU128": {
      try {
        const native = scValToNative(val);
        return `u128:${native}`;
      } catch {
        return "u128:malformed";
      }
    }

    case "scvI128": {
      try {
        const native = scValToNative(val);
        return `i128:${native}`;
      } catch {
        return "i128:malformed";
      }
    }

    case "scvU256": {
      try {
        const native = scValToNative(val);
        return `u256:${native}`;
      } catch {
        return "u256:malformed";
      }
    }

    case "scvI256": {
      try {
        const native = scValToNative(val);
        return `i256:${native}`;
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
        const rawItems = (val as { value?: () => unknown[] }).value?.();
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
        const rawEntries = (val as { value?: () => unknown[] }).value?.();
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
    return Number.isInteger(val) ? `number:${val}` : `number:${val}`;
  }

  if (typeof val === "bigint") {
    return `bigint:${val}`;
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
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return 0;
  const floored = Math.floor(n);
  return floored >= 0 ? floored : 0;
}

function toPosition(value: unknown): number | null {
  let n: number;
  if (typeof value === "number") {
    n = value;
  } else if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    n = Number(value.trim());
  } else {
    return null;
  }
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null;
  return n;
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

  const rawTopics = Array.isArray(event.topic)
    ? event.topic
    : Array.isArray((event as { topics?: unknown }).topics)
      ? (event as { topics: unknown[] }).topics
      : [];

  const eventName = rawTopics.length > 0 ? extractEventName(rawTopics[0]) : "unknown";
  const topics = renderTopics(rawTopics, options);
  const value = renderGenericScVal(event.value, 0, options);

  const topicSummary = topics.length > 0 ? topics.join(" | ") : "(none)";
  const valueSummary = value;
  const summary = `[${eventName}] ${topicSummary} => ${valueSummary}`;

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
    payload: {
      name: "generic",
      eventName,
      topics,
      value,
      summary,
    },
  };
}
