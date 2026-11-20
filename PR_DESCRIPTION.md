# Fix: Reject Noncanonical Callback Numeric Identifiers

## Summary
Enforce strict validation for numeric identifiers in callback payloads (`src/callbacks.ts`) and broadcast confirmations (`src/commands/broadcast.ts`). Disallows leading signs (`+`, `-`), unsafe integers exceeding `Number.MAX_SAFE_INTEGER` (9,007,199,254,740,991), redundant leading zeros (`0123`, `00`), and overlong decimal strings (> 16 digits), while preserving all existing valid callback payloads (e.g. `status`, `broadcast:confirm:42`, `broadcast:confirm:<base36_store_id>`).

## Context & Motivation
Callbacks and broadcast confirmations carry state-changing operator intent. Unvalidated or noncanonical numeric identifiers can lead to parser differentials, ambiguity, integer overflow/precision loss, and filter bypasses. This change hardens callback parsing against hostile or malformed numeric inputs at the ingress validation boundary.

## Changes

### 1. `src/callbacks.ts`
- Added `MAX_CANONICAL_NUMERIC_DIGITS = 16` constant corresponding to `Number.MAX_SAFE_INTEGER`.
- Added `isCanonicalNumericId(value: unknown): boolean`: Validates non-negative canonical decimal integers within the safe integer range with no leading signs or redundant leading zeros.
- Added `isNoncanonicalNumericId(value: unknown): boolean`: Detects leading signs (`+`, `-`), redundant leading zeros, unsafe integers (> `Number.MAX_SAFE_INTEGER`), overlong digit strings (> 16 digits), and non-decimal representations (hex, scientific notation, float). Preserves canonical decimal IDs and valid alphanumeric payloads.
- Added `hasNoncanonicalNumericField(obj: unknown): boolean`: Recursively scans JSON payloads for noncanonical numeric fields.
- Updated `validateCallbackData(raw: unknown)`:
  - Rejects top-level noncanonical numeric inputs with `reason: "noncanonical-numeric-id"`.
  - Rejects JSON payloads containing noncanonical numeric values with `reason: "noncanonical-numeric-id"`.
  - Rejects colon-delimited payloads where any segment is a noncanonical numeric identifier with `reason: "noncanonical-numeric-id"`.
  - Preserves canonical decimal IDs and all existing valid callback actions.

### 2. `src/commands/broadcast.ts`
- Updated `handleBroadcastCallback`:
  - Rejects noncanonical numeric broadcast IDs (`isNoncanonicalNumericId(broadcastId)`) and invalid segment counts with `"Invalid broadcast action"`.
- Updated `BroadcastStore`:
  - Defensive `get(id)` returns `undefined` when `id` is a noncanonical numeric identifier.
  - Defensive `delete(id)` returns `false` when `id` is a noncanonical numeric identifier.
- Updated `broadcastKeyboard(id: string)`:
  - Throws an `Error` if invoked with a noncanonical numeric identifier.

### 3. `src/bot.ts`
- Re-exports `isCanonicalNumericId`, `isNoncanonicalNumericId`, and `MAX_CANONICAL_NUMERIC_DIGITS` from `./callbacks.js`.

### 4. `docs/threat-model.md`
- Updated STRIDE threat item **T-03** to document enforcement against noncanonical numeric identifiers in callback queries.

### 5. `tests/callback-numeric-ids.test.mjs`
- Added comprehensive automated test suite covering:
  - `isCanonicalNumericId` unit tests (canonical integers, 0, MAX_SAFE_INTEGER, rejection of signs, leading zeros, unsafe integers, overlong strings).
  - `isNoncanonicalNumericId` unit tests (detection of noncanonical variants, preservation of canonical IDs and non-numeric strings).
  - `validateCallbackData` with colon-delimited, top-level, and JSON noncanonical inputs.
  - Preservation of all existing valid callback payloads.
  - `handleBroadcastCallback` failure cases on noncanonical IDs and success cases on canonical IDs.
  - `BroadcastStore` defense checks.
  - `broadcastKeyboard` error throwing on noncanonical IDs.
  - Ingress rejection via `handleCallbackQuery`.

## Before / After Behavior

| Input Payload / Action | Behavior Before | Behavior After |
| :--- | :--- | :--- |
| `broadcast:confirm:+123` | `validateCallbackData`: `ok: true` (passed through to handler) | `validateCallbackData`: `ok: false`, `reason: "noncanonical-numeric-id"` |
| `broadcast:confirm:-123` | `validateCallbackData`: `ok: true` | `validateCallbackData`: `ok: false`, `reason: "noncanonical-numeric-id"` |
| `broadcast:confirm:0123` | `validateCallbackData`: `ok: true` | `validateCallbackData`: `ok: false`, `reason: "noncanonical-numeric-id"` |
| `broadcast:confirm:9007199254740992` (unsafe $2^{53}$) | `validateCallbackData`: `ok: true` | `validateCallbackData`: `ok: false`, `reason: "noncanonical-numeric-id"` |
| `broadcast:confirm:99999999999999999999999999999` | `validateCallbackData`: `ok: true` | `validateCallbackData`: `ok: false`, `reason: "noncanonical-numeric-id"` |
| `status:+1`, `pause:-1`, `mimir:status:01` | `validateCallbackData`: `ok: true` | `validateCallbackData`: `ok: false`, `reason: "noncanonical-numeric-id"` |
| `{"action":"broadcast","id":"+123"}` | `validateCallbackData`: `ok: true` | `validateCallbackData`: `ok: false`, `reason: "noncanonical-numeric-id"` |
| `{"action":"broadcast","id":9007199254740992}` | `validateCallbackData`: `ok: true` | `validateCallbackData`: `ok: false`, `reason: "noncanonical-numeric-id"` |
| `handleBroadcastCallback(..., "broadcast:confirm:+123")` | Queried store with `"+123"`, answered "expired" | Rejected immediately with `"Invalid broadcast action"`, store unaccessed |
| `broadcast:confirm:42` (canonical decimal) | `ok: true` | `ok: true` (preserved) |
| `broadcast:confirm:0` (canonical zero) | `ok: true` | `ok: true` (preserved) |
| `broadcast:confirm:lx9abc_1_def` (store ID) | `ok: true` | `ok: true` (preserved) |
| `status`, `contracts`, `help`, `pause`, `resume` | `ok: true` | `ok: true` (preserved) |
| `status:refresh`, `pause:confirm` | `ok: true` | `ok: true` (preserved) |

## Verification
- `npm run scan:secrets` — 497 files scanned, 0 findings.
- `npm run typecheck` — 0 errors.
- `node --test tests/callback-numeric-ids.test.mjs tests/callback-query.test.mjs tests/callback-fuzz.test.mjs tests/broadcast-command.test.mjs tests/keyboards.test.mjs tests/pause-confirm.test.mjs` — 107/107 passing.
- Synthetic fixtures, fake transports, and temporary state used throughout; no live credentials or chain fund movement required.

## Boundaries
- Read-only bot operation preserved: no signing keys held, no chain transactions submitted.
- Chain remains authoritative.
- Notification delivery claims no exactly-once guarantees.
- Unrelated refactors and dependency upgrades kept out of scope.
