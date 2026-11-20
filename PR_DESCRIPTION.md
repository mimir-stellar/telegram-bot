## Summary

Enforce strict validation for numeric identifiers in callback payloads (`src/callbacks.ts`) and broadcast confirmations (`src/commands/broadcast.ts`). Disallows leading signs (`+`, `-`), unsafe integers exceeding `Number.MAX_SAFE_INTEGER` (9,007,199,254,740,991), redundant leading zeros (`0123`, `00`), and overlong decimal strings (> 16 digits), while preserving all existing valid callback payloads (e.g. `status`, `broadcast:confirm:42`, `broadcast:confirm:<base36_store_id>`).

Callbacks and broadcast confirmations carry state-changing operator intent. Unvalidated or noncanonical numeric identifiers can lead to parser differentials, ambiguity, integer overflow/precision loss, and filter bypasses. This change hardens callback parsing against hostile or malformed numeric inputs at the ingress validation boundary.

## Linked issue

Closes #1142

## Failure modes

| Failure mode | Behavior before | Behavior after |
| --- | --- | --- |
| Leading sign numeric IDs (`broadcast:confirm:+123`, `status:-1`) | Accepted by `validateCallbackData` as valid callback action; passed to handler | Rejected at ingress with `ok: false, reason: "noncanonical-numeric-id"` and fallback text |
| Redundant leading zeros (`broadcast:confirm:0123`, `00`) | Accepted as valid callback action | Rejected at ingress with `reason: "noncanonical-numeric-id"` |
| Unsafe integers (`broadcast:confirm:9007199254740992`, $2^{53}$) | Accepted without bounds checking | Rejected at ingress with `reason: "noncanonical-numeric-id"` |
| Overlong decimal IDs (> 16 digits, e.g. `99999999999999999999999999999`) | Accepted as valid callback action | Rejected at ingress with `reason: "noncanonical-numeric-id"` |
| Direct broadcast confirmation call with noncanonical ID | Handler queried store with `"+123"`, answered "expired" | Handler immediately rejects with `"Invalid broadcast action"`; store unaccessed |
| Noncanonical JSON callback numeric fields (`{"action":"broadcast","id":"+123"}`) | Accepted by JSON validator | Rejected by JSON recursive validator with `reason: "noncanonical-numeric-id"` |
| Canonical decimal IDs (`broadcast:confirm:42`, `0`) | Accepted | Preserved and accepted |
| Existing valid string payloads (`refresh`, `view`, `lx9abc_1_def`) | Accepted | Preserved and accepted |

## Cursor safety

Unchanged. Callbacks and broadcast confirmations never interact with, write to, or mutate the persisted cursor state file (`data/cursor.json`).

## Logs and security

- Logs and status output never disclose secrets or bot tokens; all errors pass through `safeErrorMessage` / `redactText`.
- When an invalid callback query is rejected, a bounded warning is logged:
  `[bot] rejected invalid callback query (noncanonical-numeric-id) on update <id>`
- Answer callback queries return bounded generic fallback feedback (`"Invalid or unrecognized action"` or `"Invalid broadcast action"`) without echoing unvalidated user inputs.
- Updated threat model entry **T-03** in `docs/threat-model.md` to document strict rejection of noncanonical numeric identifiers.

## Configuration and deployment impact

None. No new environment variables, configuration keys, or schema changes are introduced. Deployment profiles (`docker-compose`, `railway.json`, systemd) remain identical. Fully backward compatible with all supported callback patterns.

## Test coverage

Focused automated test suite in `tests/callback-numeric-ids.test.mjs` (14 test cases) plus existing suites:
- `isCanonicalNumericId`: verifies canonical non-negative integers (`0`, `42`, `9007199254740991`) and rejects signed, overlong, or unsafe values.
- `isNoncanonicalNumericId`: detects `+`/`-` signs, leading zeros, unsafe integers (> $2^{53}-1$), overlong strings, and preserves valid alphanumeric IDs and tokens.
- `validateCallbackData`: covers colon-delimited, top-level, and JSON noncanonical payloads.
- `handleBroadcastCallback`: covers rejection of noncanonical IDs and acceptance of canonical IDs.
- `BroadcastStore`: defensive `get` and `delete` behavior.
- `broadcastKeyboard`: verifies `Error` is thrown when given a noncanonical ID.
- `handleCallbackQuery`: verifies ingress rejection without state changes.

Verification results:
- [x] `npm run typecheck` passes (0 errors)
- [x] `npm run build` passes
- [x] `npm test` passes (no live Testnet, no Telegram credentials required; all 107 callback and broadcast suite tests pass)
- [x] `npm run scan:secrets` passes (497 files scanned, 0 findings)
- [x] Fixture guide / README / threat-model updated where behavior affecting ops changed
- [x] No real bot tokens, chat ids, or signing keys added to the repo
