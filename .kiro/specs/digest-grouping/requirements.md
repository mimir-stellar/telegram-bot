# Requirements Document

## Introduction

Digests produced by `formatDigest` in `src/notifications/format.ts` currently list every event on its own line in chronological order. A typical burst contains several events for the same claim (e.g. `claim_challenged`, `claim_resolved`, `market_settled`, `challenger_paid`) or the same squad market, making the message visually noisy. This feature groups consecutive events that share the same claim or market under a titled header with indented sub-lines, while leaving events that cannot be grouped (admin events, unknown events, or events with no groupable id) in their own singleton group. Grouping is opt-in: `formatDigest` defaults to the existing flat layout and activates the grouped layout only when the caller passes `grouped: true`.

## Glossary

- **Digest_Grouper**: The new module `src/notifications/digest-grouping.ts` that implements the grouping logic.
- **Group**: A set of one or more `DecodedEvent` objects that share the same group key, rendered as a header line followed by indented event lines.
- **Group_Key**: A string of the form `market:<claimId>` (for `mimir-market` events carrying a `claimId`) or `squad:<marketId>` (for `mimir-squad` events carrying a `marketId`). Events with no such identifier receive a unique per-event key so they each form a singleton group.
- **First-Seen Order**: The order in which group keys are encountered when iterating the input array from index 0 to the end; the order of groups in the output follows this sequence.
- **Digest_Renderer**: The part of `formatDigest` that converts groups returned by the Digest_Grouper into the final MarkdownV2 string.
- **compareEvents**: The deterministic comparator defined in `src/stellar/decode.ts` that orders events by ledger → transaction index → operation index → paging token → tx hash.
- **formatDigest**: The existing function in `src/notifications/format.ts` that produces one MarkdownV2 digest string from an array of `DecodedEvent` objects.

## Requirements

### Requirement 1: Group Digest Events by Claim or Market

**User Story:** As an operator reading digests in Telegram, I want events that relate to the same claim or squad market to appear together under a header, so that I can understand what happened to each claim or market at a glance instead of scanning an interleaved flat list.

#### Acceptance Criteria

1. THE Digest_Grouper SHALL export a function `groupDigestEvents(events: readonly DecodedEvent[]): DigestGroup[]` where `DigestGroup` is `{ key: string; events: DecodedEvent[] }`, accepting any array of `DecodedEvent` objects and returning an ordered array of groups.
2. WHEN a `DecodedEvent` has `source === 'mimir-market'` and its payload contains a `claimId` field, THE Digest_Grouper SHALL assign that event the Group_Key `market:<claimId>`.
3. WHEN a `DecodedEvent` has `source === 'mimir-squad'` and its payload contains a `marketId` field, THE Digest_Grouper SHALL assign that event the Group_Key `squad:<marketId>`.
4. WHEN an event has no groupable identifier (source is neither `mimir-market` nor `mimir-squad`, or the relevant payload field is absent), THE Digest_Grouper SHALL assign that event a unique singleton Group_Key derived from the event's `eventId` so it forms its own group.
5. WHEN a `mimir-market` event's payload does not contain a `claimId`, THE Digest_Grouper SHALL treat it as ungroupable and assign a singleton Group_Key.
6. WHEN a `mimir-squad` event's payload does not contain a `marketId`, THE Digest_Grouper SHALL treat it as ungroupable and assign a singleton Group_Key.
7. THE Digest_Grouper SHALL preserve First-Seen Order of Group_Keys across the returned array of groups.
8. WHEN multiple events share the same Group_Key, THE Digest_Grouper SHALL order those events within the group using `compareEvents`.
9. WHEN `groupDigestEvents` receives an empty array, THE Digest_Grouper SHALL return an empty array.

---

### Requirement 2: Render Grouped Digest Output

**User Story:** As an operator reading digests in Telegram, I want each group of related events to be visually separated with a clear header, so that I can quickly scan which claim or market each event belongs to.

#### Acceptance Criteria

1. WHEN `formatDigest` is called with the option `grouped: true`, THE Digest_Renderer SHALL use `groupDigestEvents` to arrange events into groups before rendering.
2. WHEN `formatDigest` is called without the `grouped` option or with `grouped: false`, THE Digest_Renderer SHALL produce output character-for-character identical to calling `formatDigest` with the same events and no second argument (default digest output is unchanged).
3. WHEN rendering a group that contains more than one event, THE Digest_Renderer SHALL emit a header line containing the MarkdownV2-escaped Group_Key (e.g. `market:42` or `squad:7`) followed by one line per event in the group, each prefixed with two spaces.
4. WHEN rendering a singleton group (exactly one event, ungroupable or alone), THE Digest_Renderer SHALL emit that event's line with no group header and no indentation prefix, matching the flat layout.
5. THE Digest_Renderer SHALL produce a MarkdownV2 string where all Telegram reserved characters in dynamic content are escaped using `escapeMd`, beginning with the existing `*Mimir Digest* — N events in this cycle` header where N is the total event count across all groups.

---

### Requirement 3: Preserve Default Digest Behaviour

**User Story:** As a developer integrating `formatDigest`, I want the default call signature to be unchanged, so that no existing callers break when this feature is added.

#### Acceptance Criteria

1. THE Digest_Renderer SHALL accept an optional second parameter `options?: { grouped?: boolean }` on `formatDigest`, defaulting to `{}`.
2. WHEN `formatDigest` is called with no second argument, THE Digest_Renderer SHALL produce a MarkdownV2 string in the flat format: the `*Mimir Digest* — N events in this cycle` header followed by one bullet line per event formatted by the existing `formatEvent` helper, with all reserved characters escaped via `escapeMd`.
3. IF `formatDigest` receives an empty event array, THEN THE Digest_Renderer SHALL return `null`, regardless of the `grouped` option.
4. WHEN `formatDigest` is called with `{ grouped: false }`, THE Digest_Renderer SHALL produce output character-for-character identical to calling `formatDigest` with the same events and no second argument.

---

### Requirement 4: Test Coverage for Digest Grouping

**User Story:** As a developer maintaining the bot, I want automated tests for the grouping logic and its integration with `formatDigest`, so that regressions are caught without manual inspection of digest output.

#### Acceptance Criteria

1. THE test file `tests/digest-grouping.test.mjs` SHALL contain at least one test that passes a mixed-burst array (containing at least one `mimir-market` event with `claimId`, one `mimir-squad` event with `marketId`, and one ungroupable event) to `groupDigestEvents` and asserts: the returned array length equals the number of distinct Group_Keys; each event appears in exactly the group matching its Group_Key; groups appear in First-Seen Order; and each group's `events` array length matches the count of input events sharing that key.
2. WHEN a mixed burst contains events for multiple distinct claims and markets interleaved, THE Digest_Grouper SHALL place each event in the group that corresponds to its Group_Key and SHALL maintain First-Seen Order of groups.
3. IF the grouped renderer is enabled (`grouped: true`), THEN THE Digest_Renderer SHALL produce a digest string that contains a header line with the MarkdownV2-escaped Group_Key for any group with more than one event, and that header line SHALL appear before the indented event lines of that group.
4. THE test suite SHALL verify that calling `formatDigest(events)` with no second argument produces a MarkdownV2 string in the flat format (the `*Mimir Digest*` header followed by one bullet per event, no group headers, all reserved characters escaped), serving as a regression guard.
5. IF the input to `groupDigestEvents` is a non-empty array of length N (tested for N = 1, N = 2, and N ≥ 3), THEN the sum of `group.events.length` across all returned groups SHALL equal N (no events are lost or duplicated).
