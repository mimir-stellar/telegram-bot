
## Summary

This PR introduces two security improvements to operator broadcast and callback handling.

### 1. Strict validation of callback numeric identifiers

Enforce strict validation for numeric identifiers in callback payloads (`src/callbacks.ts`) and broadcast confirmations (`src/commands/broadcast.ts`).

Disallows:
- Leading signs (`+`, `-`).
- Unsafe integers exceeding `Number.MAX_SAFE_INTEGER` (9,007,199,254,740,991).
- Redundant leading zeros (`0123`, `00`).
- Overlong decimal strings (more than 16 digits).

Preserves all existing valid callback payloads, including `status`, `broadcast:confirm:42`, and `broadcast:confirm:<base36_store_id>`.

Callbacks and broadcast confirmations carry state-changing operator intent. Unvalidated or noncanonical numeric identifiers can lead to parser differentials, ambiguity, integer overflow or precision loss, and filter bypasses. This change hardens callback parsing at the ingress validation boundary.

### 2. Cryptographic fingerprinting of broadcast destinations

Cryptographically fingerprint the reviewed destination set for operator broadcast previews (`/broadcast`) and automatically cancel pending confirmations if route configuration changes before confirmation.

Operators must review an updated preview before any broadcast is delivered.

Previously, if the bot's route configuration (`TELEGRAM_CHAT_ID`, `TELEGRAM_MARKET_CHAT_ID`, `TELEGRAM_SQUAD_CHAT_ID`, or per-chat routes) changed between preview generation and confirmation, the broadcast could be dispatched to an unreviewed, stale, or newly added destination set without operator review.

This change binds each pending broadcast to a canonical SHA-256 fingerprint of the reviewed destination set and invalidates pending confirmations upon any route change.

### Linked issues

- Closes #1142
- Closes #853

## Failure modes

| Failure mode | Behavior before | Behavior after |
| --- | --- | --- |
| Leading sign numeric IDs (`broadcast:confirm:+123`, `status:-1`) | Accepted by `validateCallbackData` as valid callback action; passed to handler | Rejected at ingress with `ok: false, reason: "noncanonical-numeric-id"` and fallback text |
| Redundant leading zeros (`broadcast:confirm:0123`, `00`) | Accepted as valid callback action | Rejected at ingress with `reason: "noncanonical-numeric-id"` |
| Unsafe integers (`broadcast:confirm:9007199254740992`, 2^53) | Accepted without bounds checking | Rejected at ingress with `reason: "noncanonical-numeric-id"` |
| Overlong decimal IDs (more than 16 digits) | Accepted as valid callback action | Rejected at ingress with `reason: "noncanonical-numeric-id"` |
| Direct broadcast confirmation call with noncanonical ID | Handler queried store with `"+123"`, answered "expired" | Handler immediately rejects with `"Invalid broadcast action"`; store unaccessed |
| Noncanonical JSON callback numeric fields (`{"action":"broadcast","id":"+123"}`) | Accepted by JSON validator | Rejected by JSON recursive validator with `reason: "noncanonical-numeric-id"` |
| Canonical decimal IDs (`broadcast:confirm:42`, `0`) | Accepted | Preserved and accepted |
| Existing valid string payloads (`refresh`, `view`, `lx9abc_1_def`) | Accepted | Preserved and accepted |
| Route added before confirmation (e.g. new chat configured in `TELEGRAM_CHAT_ID` or routes) | Sent message to old or modified destinations without operator review | Confirmation rejected; pending broadcast cancelled from store; operator alerted that route configuration changed and a new preview is required; 0 messages sent |
| Route removed before confirmation (e.g. revoked chat destination) | Broadcasted to stale or revoked destination set | Confirmation rejected; pending confirmation cancelled; 0 messages sent |
| Route reordered in config (e.g. `[chatA, chatB]` to `[chatB, chatA]`) | No fingerprint protection | Canonical fingerprint is order-independent and deduplicated; confirmation succeeds normally |
| Proactive route configuration change | Pending confirmations remained active with old destination set | `BroadcastStore.cancelOnRouteChange()` cancels and purges mismatched items, recording `"route-change"` cancellation reason |
| Cancel clicked after route change | Cancelled broadcast | Cancelled cleanly; pending broadcast removed from store |
| Unchanged route configuration | Broadcast delivered to configured chats | Preserved; broadcast delivered to reviewed chats |

## Cursor safety

Unchanged.

Callbacks and broadcast confirmations never interact with, write to, or mutate the persisted cursor state file (`data/cursor.json`).

Broadcasts and operator confirmations operate independently of the poller cursor and never access or mutate the persisted cursor state file.

## Logs and security

- Logs and status output never disclose secrets or bot tokens; all errors pass through `safeErrorMessage` / `redactText`.
- When an invalid callback query is rejected, a bounded warning is logged:

  `[bot] rejected invalid callback query (noncanonical-numeric-id) on update <id>`

- Answer callback queries return bounded generic fallback feedback (`"Invalid or unrecognized action"` or `"Invalid broadcast action"`) without echoing unvalidated user inputs.
- When confirmation is attempted on a broadcast whose route configuration changed:
  - Callback query returns user-facing alert: `"Route configuration changed. New preview required."`
  - Inline message is edited with warning: `"⚠️ Route configuration changed since preview. Broadcast confirmation cancelled. Run /broadcast again for an updated preview."`
  - No messages are dispatched to any chat.
- Updated threat model entries:
  - **T-03:** Strict rejection of noncanonical numeric identifiers.
  - **T-18:** Route desynchronization and destination set fingerprinting.

## Configuration and deployment impact

No new environment variables, configuration keys, or schema migrations are introduced.

- Deployment profiles (`docker-compose`, `railway.json`, systemd) remain identical.
- Fully backward compatible with all supported callback patterns.
- Existing deployment targets and configuration shapes remain supported.
- Added support for per-chat `routes` in `getConfiguredBroadcastChats`.

## Test coverage

### Numeric callback validation

Focused automated test suite: `tests/callback-numeric-ids.test.mjs` (14 test cases), plus existing suites.

Coverage includes:

- `isCanonicalNumericId`: verifies canonical non-negative integers (`0`, `42`, `9007199254740991`) and rejects signed, overlong, or unsafe values.
- `isNoncanonicalNumericId`: detects `+`/`-` signs, leading zeros, unsafe integers (greater than 2^53 - 1), overlong strings, and preserves valid alphanumeric IDs and tokens.
- `validateCallbackData`: covers colon-delimited, top-level, and JSON noncanonical payloads.
- `handleBroadcastCallback`: covers rejection of noncanonical IDs and acceptance of canonical IDs.
- `BroadcastStore`: defensive `get` and `delete` behavior.
- `broadcastKeyboard`: verifies `Error` is thrown when given a noncanonical ID.
- `handleCallbackQuery`: verifies ingress rejection without state changes.

### Broadcast destination fingerprinting

Focused automated test suites:

- `tests/broadcast-route-change.test.mjs` (16 test cases).
- `tests/broadcast-command.test.mjs` (14 test cases).

Coverage includes:

- `fingerprintDestinationSet`: verifies deterministic 64-character SHA-256 hex strings, order independence across permutations, deduplication, whitespace normalization, and sensitivity to additions, removals, and modifications.
- `getConfiguredBroadcastChats`: verifies chat extraction across `chatId`, `chatIds`, `marketChatId`, `squadChatId`, and `routes`.
- `handleBroadcastCommand`: verifies destination fingerprint is recorded in `PendingBroadcast` and displayed in preview message.
- `handleBroadcastCallback`: verifies confirmation succeeds with unchanged or reordered routes, and is cancelled or rejected with zero sends when routes are added, removed, or changed.
- `BroadcastStore`: verifies `cancelOnRouteChange` purges mismatched items while preserving matching items, and tracks `"route-change"` cancellation reason.
- `handleCallbackQuery`: verifies full ingress integration and operator feedback.

## Verification results

### Numeric callback validation

- [x] `npm run typecheck` passes (0 errors).
- [x] `npm run build` passes.
- [x] `npm test` passes (all 107 callback and broadcast suite tests pass; no live Testnet or Telegram credentials required).
- [x] `npm run scan:secrets` passes (497 files scanned, 0 findings).
- [x] Fixture guide, README, and threat model updated where behavior affecting operations changed.

### Broadcast destination fingerprinting

- [x] `npm run scan:secrets` passes (497 files scanned, 0 findings).
- [x] `npm run typecheck` passes (0 errors).
- [x] `npm run build` passes.
- [x] `npm test` passes (all broadcast unit and regression tests pass without live network credentials).
- [x] Threat model and documentation updated (`docs/threat-model.md`, `src/callbacks.ts`, `src/commands/broadcast.ts`).

### Final security check

- [x] No real bot tokens, chat IDs, or signing keys added to the repository.
