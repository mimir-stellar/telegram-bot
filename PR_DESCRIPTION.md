## Summary

Cryptographically fingerprint the reviewed destination set for operator broadcast previews (`/broadcast`), and automatically cancel pending confirmations if route configuration changes before confirmation. Operators must review an updated preview before any broadcast is delivered.

Broadcast confirmations carry state-changing operator intent. Previously, if the bot's route configuration (`TELEGRAM_CHAT_ID`, `TELEGRAM_MARKET_CHAT_ID`, `TELEGRAM_SQUAD_CHAT_ID`, or per-chat routes) changed between preview generation and confirmation click, the broadcast could be dispatched to an unreviewed, stale, or newly added destination set without operator review. This change binds each pending broadcast to a canonical SHA-256 fingerprint of the reviewed destination set and invalidates pending confirmations upon any route change.

## Linked issue

Closes #853

## Failure modes

| Failure mode | Behavior before | Behavior after |
| --- | --- | --- |
| Route added before confirmation (e.g. new chat configured in `TELEGRAM_CHAT_ID` or routes) | Sent message to old or modified destinations without operator review | Confirmation rejected; pending broadcast cancelled from store; operator alerted that route configuration changed and a new preview is required; 0 messages sent |
| Route removed before confirmation (e.g. revoked chat destination) | Broadcasted to stale/revoked destination set | Confirmation rejected; pending confirmation cancelled; 0 messages sent |
| Route reordered in config (e.g. `[chatA, chatB]` -> `[chatB, chatA]`) | N/A | Canonical fingerprint is order-independent and deduplicated; confirmation succeeds normally |
| Proactive route configuration change | Pending confirmations remained active with old destination set | `BroadcastStore.cancelOnRouteChange()` cancels and purges mismatched items, recording `"route-change"` cancellation reason |
| Cancel clicked after route change | Cancelled broadcast | Cancelled cleanly; pending broadcast removed from store |
| Unchanged route configuration | Broadcast delivered to configured chats | Preserved; broadcast delivered to reviewed chats |

## Cursor safety

Unchanged. Broadcasts and operator confirmations operate independently of the poller cursor and never access or mutate the persisted cursor state file (`data/cursor.json`).

## Logs and security

- Logs and status output never disclose secrets or bot tokens; all errors pass through `safeErrorMessage` / `redactText`.
- When confirmation is attempted on a broadcast whose route configuration changed:
  - Callback query returns user-facing alert: `"Route configuration changed. New preview required."`
  - Inline message is edited with warning: `"⚠️ Route configuration changed since preview. Broadcast confirmation cancelled. Run /broadcast again for an updated preview."`
  - No messages are dispatched to any chat.
- Threat model entry **T-18** added to `docs/threat-model.md` covering route desynchronization and destination set fingerprinting.

## Configuration and deployment impact

None. No new environment variables or schema migrations are introduced. Fully backward compatible with all existing deployment targets and configuration shapes, with added support for per-chat `routes` in `getConfiguredBroadcastChats`.

## Test coverage

Focused automated test suite in `tests/broadcast-route-change.test.mjs` (16 test cases) plus existing broadcast test suite in `tests/broadcast-command.test.mjs` (14 test cases):
- `fingerprintDestinationSet`: verifies deterministic 64-character SHA-256 hex string, order-independence across permutations, deduplication, whitespace normalization, and sensitivity to additions, removals, and modifications.
- `getConfiguredBroadcastChats`: verifies chat extraction across `chatId`, `chatIds`, `marketChatId`, `squadChatId`, and `routes`.
- `handleBroadcastCommand`: verifies destination fingerprint is recorded in `PendingBroadcast` and displayed in preview message.
- `handleBroadcastCallback`: verifies confirmation succeeds with unchanged/reordered routes, and is cancelled/rejected with zero sends when routes are added, removed, or changed.
- `BroadcastStore`: verifies `cancelOnRouteChange` purges mismatched items while preserving matching items, and tracks `"route-change"` cancellation reason.
- `handleCallbackQuery`: verifies full ingress integration and operator feedback.

Verification results:
- [x] `npm run scan:secrets` passes (497 files scanned, 0 findings)
- [x] `npm run typecheck` passes (0 errors)
- [x] `npm run build` passes
- [x] `npm test` passes (all broadcast unit and regression tests pass without live network credentials)
- [x] Threat model / documentation updated (`docs/threat-model.md`, `src/callbacks.ts`, `src/commands/broadcast.ts`)
- [x] No real bot tokens, chat ids, or signing keys added to the repo
