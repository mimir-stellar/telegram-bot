# Configuration and Operational Reference

This document outlines the expected behavior of the Mimir Telegram bot under long-running failure scenarios, operational safeguards, and how configuration drives these behaviors.

## Guiding Principles
- **Read-Only**: The bot strictly reads from the chain and writes to Telegram. It holds no signing keys and never signs or submits transactions. The blockchain is the sole source of truth.
- **Fail Fast on Boot**: Configuration is validated synchronously on startup. If environment variables are missing, malformed, or internally inconsistent, the bot crashes immediately with a detailed error listing all problems, preventing silent failures.
- **Resilience During Operation**: Once running, the bot gracefully handles transient errors from the Stellar RPC and Telegram APIs. It will retry without crashing the process.

## Environment Variables (`.env`)

The `.env.example` file contains the base configuration. The bot uses strict environment variable loading.

### Telegram Settings
- `BOT_TOKEN`: The API token for the Telegram bot. Required.
- `TELEGRAM_CHAT_ID`: The chat identifier where notifications are posted. Required. Accepts either an integer decimal string (positive or negative, arbitrarily large, e.g. `-1001234567890123456`), or a channel handle such as `@channelusername`. Fractional values (`-100.5`) and exponent notation (`-1e12`) are rejected at startup; identifiers are kept as strings and never converted through JavaScript numbers.
- `MIMIR_LOCALE`: Language for bot replies and notifications. Supported: `en` (default) and `es`; region tags such as `es-MX` resolve to the base language. Any other value fails fast at startup. See [Translator Guide](translating.md).
- `BROADCAST_CONFIRMATION_STORE_PATH`: Optional path to a JSON file where `/broadcast` confirmation identities (operator, chat, action, expiry, consumed state) are persisted. When set, confirmations that were already consumed or have expired are rejected after a process restart, so a replayed Confirm button cannot re-send a broadcast. Message bodies are never written to disk. Defaults to unset (in-memory only). Use a path on a persistent volume, e.g. `data/broadcast-confirmations.json`.
- **Slash-command argument limit**: All registered slash commands enforce a shared 256-byte UTF-8 argument limit (`MAX_COMMAND_ARGUMENT_BYTES`) before individual handlers run. Arguments exceeding the limit are rejected with a bounded reply and logged with byte counts only, never full user input.

### Mimir Contract Settings
- `MARKET_CONTRACT_ID`: The Mimir market Soroban contract address. Required. Must be a valid `C...` strkey.
- `SQUAD_CONTRACT_ID`: The Mimir squad Soroban contract address. Required. Must be a valid `C...` strkey.

### Network Settings
- `STELLAR_RPC_URL`: The Soroban RPC endpoint used to poll for events. (e.g., `https://soroban-testnet.stellar.org`).
- `STELLAR_RPC_EGRESS_ALLOWLIST`: Optional comma-separated list of allowed RPC egress hosts, wildcards, or origins (e.g., `soroban-testnet.stellar.org,*.stellar.org`). When set, both initial RPC URLs and HTTP redirect destinations are validated against the allowlist, while credential-free loopback URLs (`127.0.0.1`, `localhost`, `::1`) remain permitted in `MIMIR_PROFILE=mock`.
- `STELLAR_HORIZON_URL`: Used for generating transaction links.
- `STELLAR_EXPLORER_BASE_URL`: Explorer origin for transaction links (default `https://stellar.expert/explorer`). Only `https:` origins become clickable links in notifications; see [notification-links.md](notification-links.md).
- `STELLAR_NETWORK_PASSPHRASE`: Must match the RPC network's passphrase.

### Poller Tuning & Safeguards
- `POLL_INTERVAL_MS`: How often to query the RPC for new events. Minimum is 5000ms. Testnet ledgers close roughly every 5 seconds.
- `START_LOOKBACK_LEDGERS`: On a cold start (no cursor file), the number of recent ledgers to check for events. Defaults to 60. Limits unbounded backfilling.
- `CURSOR_FILE`: Path to a persistent JSON file where the bot stores its last-seen ledger cursor.
- `MAX_NOTIFICATIONS_PER_CYCLE`: Operational safeguard. The maximum number of notifications to dispatch in a single poll cycle. Defaults to 20. Prevents Telegram rate limiting if a massive burst of events occurs on-chain. Additional events are skipped (logged), but the cursor advances.

### Notification Filtering
- `NOTIFY_ENABLED`, `NOTIFY_MARKET`, `NOTIFY_SQUAD`: Coarse boolean kill switches for global or per-contract notifications (all default to `true`).
- `SILENT_EVENTS`: Comma-separated event names sent without sound. Defaults to deposits, withdrawals, and fee claims; unknown names fail configuration validation.
- `NOTIFY_CATEGORIES` (along with aliases `NOTIFICATION_CATEGORIES`, `NOTIFY_EVENT_CATEGORIES`, `EVENT_CATEGORIES`, and `CLAIM_CATEGORIES`): Optional allowlist restricting `mimir-market` `claim_created` notifications by category.
- For full details on defaults, evaluation precedence, and worked examples, see [Notification Filters](notification-filters.md).
- **Zero active routes**: When every configured route is disabled (`NOTIFY_ENABLED=false`, or both `NOTIFY_MARKET` and `NOTIFY_SQUAD` set to `false`), the notifier reports an explicit `no-active-routes` status instead of a healthy delivery status. No notification is ever reported as delivered in this state; each would-be event is counted as suppressed and logged at warn level with the reason `no active routes`.

### Routing Preview (Dry Run)
Routing previews report which Telegram destinations an event would be delivered to, without calling Telegram `sendMessage`. The preview uses the same decision path as live notification delivery, so it returns:
- **matched**: destinations that would receive the notification.
- **filtered**: destinations excluded by `NOTIFY_ENABLED`, `NOTIFY_MARKET`, `NOTIFY_SQUAD`, `NOTIFY_CATEGORIES` (and aliases), or other notification filters.
- **unavailable**: destinations that cannot currently receive messages (for example, a missing or unconfigured `TELEGRAM_CHAT_ID`).

Previews are read-only: they perform no Telegram API calls, do not advance the cursor, and do not write to `CURSOR_FILE`. A preview does not guarantee delivery; the live path remains the authority for what is actually sent.

### Operator Digest Preview
Operators can inspect the current pending digest window via `/digestpreview [grouped|flat]` (backed by `previewPendingDigest` in `src/notifications/digest-preview.ts` and the optional `digestWindow` dependency on `CommandDeps`).
- **Live builder, non-consuming**: renders pending events through `formatDigest` without draining or mutating the pending window (for example, `DeferredQueue.peek()`), so subsequent scheduled flushes still receive all pending events.
- **Operator authorization**: protected by the existing `OPERATOR_TELEGRAM_USER_ID` gate (`operatorOnly: true`, `hidden: true`). Non-operators and deployments without `OPERATOR_TELEGRAM_USER_ID` are silently ignored without reading the pending window.
- **Completeness & schedule**: preserves period completeness metadata (`rpc_gap`, `restart`) and displays the next scheduled digest timestamp when provided.

### Health Reporting
- `HEALTH_HOST` & `HEALTH_PORT`: Binds a local HTTP endpoint for health probes (e.g., Kubernetes liveness probes). Set port to 0 to disable.
- `HEALTH_STALE_MS`: Marks the health endpoint as degraded if no successful poll completes within this window (e.g., 90000ms).
- `HEALTH_AUTH_TOKEN`: Optional bearer token for all health/metrics routes. Authorization headers over 4096 UTF-8 bytes (including `Bearer `) are rejected with the same empty `401` as other malformed values.

## Operational Behavior

### RPC Failures and Rate Limits
- **Behavior**: If the Stellar RPC is unreachable, returns HTTP 5xx, or rate-limits the bot (HTTP 429), the polling cycle catches the error, logs a warning, and skips the cycle.
- **Safeguard**: The bot does not crash. The next cycle attempts the poll again from the same cursor. The health endpoint will start reporting degraded if the failure duration exceeds `HEALTH_STALE_MS`.

### Telegram Failures and Rate Limits
- **Behavior**: If Telegram's API is unreachable or rate-limits the bot (HTTP 429), the `grammy` framework handles standard retry-after backoffs. If the dispatch completely fails, the bot logs the failure.
- **Safeguard**: `MAX_NOTIFICATIONS_PER_CYCLE` prevents internal bursts from hitting Telegram's strict anti-spam rate limits.
- **Delivery semantics**: Notification delivery is at-least-once in the presence of failures and is **not** exactly-once. Do not rely on delivery receipts as proof of a chain event having been announced.

### Broadcast Confirmations
- **Behavior**: `/broadcast` confirmations are bound to the issuing operator, the chat in which they were issued, and the action (confirm or cancel). Each identity is consumed on first use.
- **Pending List & Explicit Cancellation**: Operators in private chat can inspect their active pending confirmations with `/broadcast list` (or `/confirmations`) and explicitly cancel an action by ID (`/broadcast cancel <id>`, `/confirmations cancel <id>`, `/confirmations cancel all`, or via the inline cancel button). The pending confirmation store and listing are bounded to `MAX_PENDING_CONFIRMATIONS` (20 entries, oldest evicted at capacity). Listings show only the current operator's unexpired actions with remaining time and expiry timestamp, and report only destination counts so target chat IDs or other operators' actions are never exposed.
- **Restarts**: When `BROADCAST_CONFIRMATION_STORE_PATH` is set, identities survive restarts. Replayed or expired confirmations are rejected after a restart. Without it, pending confirmations are lost on restart and are rejected as unknown.

### Cursor Management and Restarts
- **Behavior**: The cursor (the last ingested event's ledger sequence and ID) is persisted to `CURSOR_FILE` after events are dispatched.
- **Cold Start (No Cursor)**: The bot calculates a start ledger using the current network ledger minus `START_LOOKBACK_LEDGERS`. This prevents it from attempting to fetch all historical events.
- **Warm Start (Existing Cursor)**: The bot reads `CURSOR_FILE`. It validates the format.
- **Corrupt Cursor**: If the cursor file is missing, empty, or structurally invalid, it's treated as a Cold Start. If it contains data but is stale (far behind the network tip), the RPC's retention window might clip the query. The poller automatically resets to the lookback window if the cursor is too old.

### Malformed On-Chain Events
- **Behavior**: If a parsed event matches the watched topics but has a payload that doesn't match expected XDR/contract semantics, the decoding step will safely catch the discrepancy.
- **Safeguard**: The event is skipped (with a debug log) and the cursor continues to advance. The bot does not crash and does not log raw, unbounded payloads to prevent log stuffing.

### Logs
- Operational outputs are structured and actionable.
- **Redaction**: Bot tokens and private payloads are never logged.

## Deployment & Rollback

### Assumptions
- Node.js version 20+.
- `CURSOR_FILE` exists on a persistent volume. If the deployment is ephemeral and restarts frequently, mounting a volume for `data/cursor.json` ensures the bot doesn't spam recent events on every restart.
- If `/broadcast` confirmations must survive restarts, `BROADCAST_CONFIRMATION_STORE_PATH` must also point at a persistent volume.

### Rollback
- Since the bot is read-only, rolling back to an older version requires no on-chain coordination or state migrations.
- **Cursor Compatibility**: If a rollback happens, ensure the older version is compatible with the format in `CURSOR_FILE` (a JSON object with `ledger` and `id`). If incompatible, clear the cursor file for a cold start lookback.
- **Broadcast Store Compatibility**: The confirmation file is versioned (`version: 1`). Rolling back to a version without this feature simply ignores the file; in-flight confirmations are then lost, which fails closed.
