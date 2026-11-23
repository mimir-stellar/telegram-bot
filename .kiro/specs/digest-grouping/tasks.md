# Implementation Tasks

## Task 1: Create `src/notifications/digest-grouping.ts`

- [ ] Define `DigestGroup` interface (`key: string; events: DecodedEvent[]`)
- [ ] Export `groupDigestEvents(events: readonly DecodedEvent[]): DigestGroup[]`
  - Derive Group_Key per event (`market:`, `squad:`, `ungroupable:`)
  - Preserve First-Seen Order via insertion-order `Map`
  - Sort each group's events with `compareEvents` / `sortEvents`
  - Return empty array for empty input

## Task 2: Update `src/notifications/format.ts`

- [ ] Add `FormatDigestOptions` interface (`grouped?: boolean`)
- [ ] Extract `flatLine(event)` private helper from existing `formatDigest` body
- [ ] Add private `renderGroupedDigest(events)` that calls `groupDigestEvents`
  and renders header + indented lines for multi-event groups, plain lines for singletons
- [ ] Update `formatDigest` signature to accept `options: FormatDigestOptions = {}`
- [ ] Branch on `options.grouped` — grouped path calls `renderGroupedDigest`,
  flat path uses the unchanged existing code (via `flatLine`)
- [ ] Import `groupDigestEvents` from `./digest-grouping.js`

## Task 3: Add `tests/digest-grouping.test.mjs`

- [ ] Test empty input returns `[]`
- [ ] Test single market / squad / ungroupable events
- [ ] Test mixed-burst array: correct group keys, First-Seen Order, count invariant
- [ ] Test interleaved keys (A, B, A, B → 2 groups)
- [ ] Test intra-group ordering by ledger
- [ ] Test `formatDigest` flat output (no options) — regression guard
- [ ] Test `formatDigest` grouped output — header present, indented lines
- [ ] Test `{ grouped: false }` equals no-options output
- [ ] Test `formatDigest` with empty array returns `null` regardless of `grouped`
