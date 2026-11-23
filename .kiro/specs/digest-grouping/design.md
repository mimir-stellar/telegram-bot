# Design Document

## Overview

This feature adds opt-in grouping to `formatDigest`. A new module,
`src/notifications/digest-grouping.ts`, derives a Group_Key for each
`DecodedEvent` and buckets events by that key. `formatDigest` gains an optional
`options` parameter; when `options.grouped` is `true` it delegates to the
grouper and renders headers + indented lines. All existing callers are
unaffected because the parameter defaults to `{}` and the default path is
identical to the current code.

---

## Architecture

```
formatDigest(events, { grouped: true })
        │
        ▼
groupDigestEvents(events)   ← new module
        │  returns DigestGroup[]
        ▼
renderGroupedDigest(groups) ← new helper inside format.ts
        │
        ▼
MarkdownV2 string
```

No new dependencies. Both new functions are pure (no I/O, no side effects).

---

## Data Shapes

### `DigestGroup` (exported from `digest-grouping.ts`)

```ts
export interface DigestGroup {
  /** "market:<claimId>" | "squad:<marketId>" | "ungroupable:<eventId>" */
  key: string;
  events: DecodedEvent[];
}
```

### `FormatDigestOptions` (defined in `format.ts`)

```ts
export interface FormatDigestOptions {
  grouped?: boolean;
}
```

---

## Module: `src/notifications/digest-grouping.ts`

### `groupDigestEvents(events)`

**Signature**
```ts
export function groupDigestEvents(
  events: readonly DecodedEvent[],
): DigestGroup[]
```

**Algorithm**

1. Iterate `events` in order (index 0 → end).
2. For each event, derive a key:
   - `source === 'mimir-market'` AND `payload.claimId` is defined →
     `"market:" + String(payload.claimId)`
   - `source === 'mimir-squad'` AND `payload.marketId` is defined →
     `"squad:" + String(payload.marketId)`
   - otherwise → `"ungroupable:" + event.eventId`
3. Maintain an insertion-order `Map<string, DecodedEvent[]>`.
   - If the key is already in the map, push to its array.
   - If not, set a new entry `[key, [event]]` — this is First-Seen Order.
4. After the loop, sort each group's `events` array with `compareEvents`
   (stable sort within each group; `sortEvents` from `decode.ts` is reused).
5. Return `Array.from(map.entries()).map(([key, events]) => ({ key, events }))`.

Edge cases:
- Empty input → return `[]`.
- Single event → one group with one event (no sort needed, trivially correct).
- Two events with the same `eventId` but different keys → different groups
  (keys are derived before dedup; upstream `sortEvents` / `dedupeEvents` already
  ensures eventIds are unique by the time `formatDigest` is called).

**Key derivation — source field**

`ContractSource` values are `"market"` and `"squad"` (from `decode.ts`). The
existing `formatDigest` renders them with `mimir-${event.source}`, so the prefix
in the Group_Key (`market:` / `squad:`) aligns with operator-visible labels.

Note: `source` on `EventMeta` is typed as `ContractSource` (`"market" | "squad"`),
not `"mimir-market"` / `"mimir-squad"`. The requirements document uses the
`mimir-` prefix colloquially. Implementation checks `source === "market"` and
`source === "squad"`.

---

## Changes to `src/notifications/format.ts`

### Updated signature of `formatDigest`

```ts
export function formatDigest(
  events: readonly DecodedEvent[],
  options: FormatDigestOptions = {},
): string | null
```

The body becomes:

```ts
if (events.length === 0) return null;
if (options.grouped) return renderGroupedDigest(events);
// existing flat path unchanged
const lines = events.map((event) => { … });
return [`*Mimir Digest* — ${events.length} events in this cycle`, "", ...lines].join("\n");
```

### New helper `renderGroupedDigest(events)` (private, inside `format.ts`)

```ts
function renderGroupedDigest(events: readonly DecodedEvent[]): string {
  const groups = groupDigestEvents(events);
  const total = events.length;
  const header = `*Mimir Digest* — ${total} events in this cycle`;
  const body: string[] = [];

  for (const group of groups) {
    if (group.events.length === 1) {
      // Singleton: render exactly like the flat layout — no header, no indent.
      const e = group.events[0];
      body.push(flatLine(e));
    } else {
      // Multi-event group: escaped Group_Key as header, then indented lines.
      body.push(escapeMd(group.key));
      for (const e of group.events) {
        body.push(`  ${flatLine(e)}`);
      }
    }
  }

  return [header, "", ...body].join("\n");
}

// Extracted from the existing formatDigest flat path (no logic change):
function flatLine(event: DecodedEvent): string {
  const name = event.payload.name === "unknown" ? event.payload.eventName : event.payload.name;
  return `· mimir\\-${escapeMd(event.source)} \`${escapeMd(clip(name, 80))}\` at ledger ${event.ledger}`;
}
```

Extracting `flatLine` keeps the flat path bit-for-bit identical (regression
guard) while sharing the logic with the grouped renderer.

---

## Test File: `tests/digest-grouping.test.mjs`

Tests run against the built output in `dist/`, matching the project convention
(see `allowlist.test.mjs`). No test framework beyond `node:test` and
`node:assert/strict`.

### Test cases

| # | Description | What is asserted |
|---|-------------|------------------|
| 1 | Empty input | `groupDigestEvents([])` returns `[]` |
| 2 | Single market event | one group, key `market:1`, 1 event |
| 3 | Single squad event | one group, key `squad:7`, 1 event |
| 4 | Ungroupable event | key starts with `ungroupable:` |
| 5 | Mixed burst (market ×2, squad ×1, ungroupable ×1) | 3 groups in First-Seen Order; market group has 2 events; count invariant (sum = 4) |
| 6 | Interleaved keys (A, B, A, B) | 2 groups; A has 2 events, B has 2 events; First-Seen Order A→B |
| 7 | Intra-group ordering uses compareEvents | lower-ledger event comes first inside the group |
| 8 | Count invariant for N=1, N=2, N≥3 | sum of group event lengths equals input length |
| 9 | `formatDigest` flat (no options) | contains `*Mimir Digest*`, one `·` line per event, no group headers |
| 10 | `formatDigest` `{ grouped: true }` with 2-event market group | output contains escaped `market:1` header and two `  ·` indented lines |
| 11 | `formatDigest` `{ grouped: false }` === no-options | character-for-character equal |
| 12 | `formatDigest` singletons in grouped mode | no header line, same as flat |
| 13 | `formatDigest` empty → `null` with `{ grouped: true }` | returns null |

---

## Rendering Contract

### Header line for a multi-event group

The Group_Key is MarkdownV2-escaped before emission (because `:` and digits are
not reserved, escaping is a no-op for typical keys, but the rule is applied
uniformly for correctness). Example:

```
market\:42
  · mimir\-market \`claim\_challenged\` at ledger 1000
  · mimir\-market \`claim\_resolved\` at ledger 1001
```

### Singleton (ungroupable or alone)

```
· mimir\-market \`fee\_claimed\` at ledger 1002
```

No header, no indentation — identical to the flat layout.

---

## File Map

| File | Change |
|------|--------|
| `src/notifications/digest-grouping.ts` | **New** — `DigestGroup`, `groupDigestEvents` |
| `src/notifications/format.ts` | **Modified** — add `FormatDigestOptions`, optional `options` param on `formatDigest`, extract `flatLine`, add `renderGroupedDigest`, import `groupDigestEvents` |
| `tests/digest-grouping.test.mjs` | **New** — 13 test cases |

No other files change.
