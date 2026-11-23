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
- `TELEGRAM_TOPIC_ID`: Optional numeric message thread (topic) ID within `TELEGRAM_CHAT_ID`. When set, notifications are posted to that specific topic in a forum-enabled supergroup. Topics are distinct routes even when they share a chat: operator diagnostics report each route's topic identifier separately so operators can tell apart two topics in the same chat. Topic identifiers are shown in operator diagnostics only in redacted form (see below); they are never printed in full in public diagnostics, logs, or health output.
- `MIMIR_LOCALE`: Language for bot replies and notifications. Supported: `en` (default) and `es`; region tags such as `es-MX` resolve to the base language. Any other value fails fast at startup. See [Translator Guide](translating.md).
- Per-route language preference (`TelegramRoute.locale`): Optional locale override on individual entries in `config.routes` (matched by destination `chatId`). Region tags such as `es-MX` resolve to the base language; omitted or unsupported route locales fall back deterministically to the global `config.locale` and then to `en`. Applies across MarkdownV2, plaintext, HTML, and inline keyboard renderers.

### Mimir Contract Settings
- `MARKET_CONTRACT_ID`: The Mimir market Soroban contract address. Required. Must be a valid `C...` strkey.
- `SQUAD_CONTRACT_ID`: The Mimir squad Soroban contract address. Required. Must be a valid `C...` strkey.

### Network Settings
- `STELLAR_RPC_URL`: The Soroban RPC endpoint used to poll for events. (e.g., `https://soroban-testnet.stellar.org`). Must be a valid `http(s)` URL without embedded credentials (`user:pass@host`); invalid URLs fail fast before startup and report only the affected configuration key.
- `STELLAR_HORIZON_URL`: Used for generating transaction links. Must be a valid `http(s)` URL without embedded credentials.
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

### Shareable Archive Privacy Review
Shareable event archives (JSONL captures produced by the archive helpers) can be checked before they leave the operator's machine. The privacy review mode scans an archive file and produces a deterministic findings report. It is fully offline: it performs no network calls to Telegram, Stellar RPC, or Horizon, and it never modifies the archive.

- **Detected findings**:
  - `private_chat_id`: Telegram private chat identifiers (numeric IDs that are positive, i.e. user-scoped rather than group/channel IDs, and `@username`-style handles found under chat-identifying keys).
  - `secret_value`: secret-shaped values, such as Telegram bot tokens (`<digits>:<35 chars>`), `S...` Stellar secret seeds, and values under secret-named keys (`token`, `secret`, `password`, `api_key`, `private_key`, etc.).
- **Output**: findings are sorted by line number, then kind, then column, so repeated runs over the same input produce byte-identical reports. Each finding records the line, JSON path, kind, and a redacted preview; raw secret or chat values are never printed in the report.
- **Failure handling**: malformed JSONL lines are reported as `parse_error` findings rather than aborting the scan.
- **Usage**: run the review on an archive path before sharing it. A non-empty findings list means the archive should be scrubbed before distribution.

### Health Reporting
- `HEALTH_HOST` & `HEALTH_PORT`: Binds a local HTTP endpoint for health probes (e.g., Kubernetes liveness probes). Set port to 0 to disable.
- `HEALTH_STALE_MS`: Marks the health endpoint as degraded if no successful poll completes within this window (e.g., 90000ms).
- `HEALTH_AUTH_TOKEN`: Optional bearer token for all health/metrics routes. Authorization headers over 4096 UTF-8 bytes (including `Bearer `) are rejected with the same empty `401` as other malformed values.

### Logging
- `LOG_LEVEL`: Minimum severity emitted (`info` by default).
- `LOG_FORMAT`: Console format (`text` by default, or `json` for one JSON object per line).
- `LOG_FILE`: Optional path for a local JSONL operational log. Unset by default; records are appended as redacted JSON lines regardless of `LOG_FORMAT`.
- `LOG_FILE_MAX_BYTES`: Rotation threshold in bytes (10 MiB by default; invalid values fall back to the default).
- `LOG_FILE_MAX_FILES`: Total local files retained, including the active file (5 by default, clamped to 1–50). `1` keeps only the active file.

## Operational Behavior

### RPC Failures and Rate Limits
- **Behavior**: If the Stellar RPC is unreachable, returns HTTP 5xx, or rate-limits the bot (HTTP 429), the polling cycle catches the error, logs a warning, and skips the cycle.
- **Safeguard**: The bot does not crash. The next cycle attempts the poll again from the same cursor. The health endpoint will start reporting degraded if the failure duration exceeds `HEALTH_STALE_MS`.

### Telegram Failures and Rate Limits
- **Behavior**: If Telegram's API is unreachable or rate-limits the bot (HTTP 429), the `grammy` framework handles standard retry-after backoffs. If the dispatch completely fails, the bot logs the failure.
- **Safeguard**: `MAX_NOTIFICATIONS_PER_CYCLE` prevents internal bursts from hitting Telegram's strict anti-spam rate limits.
- **Delivery Semantics**: Notification delivery is at-least-once in the best case and is not guaranteed to be exactly-once. Diagnostics must not claim otherwise.

### Route Diagnostics and Redaction
- Operator route diagnostics list each configured Telegram route with its destination chat and topic identifiers so that separate topics within the same chat can be distinguished. Topic identifiers are reported per route, even when multiple routes share the same chat.
- Destination identifiers (chat IDs, channel usernames, and topic IDs) are redacted from public diagnostics (health endpoints, public metrics, and shared logs). Only a short masked form such as `***1234` is displayed.
- Full identifiers appear only in operator-only diagnostics that require `HEALTH_AUTH_TOKEN` authorization. Topic identifiers follow the same rule: they are masked in every public surface and are never emitted in full outside authorized operator diagnostics.

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
- **Optional file sink**: `LOG_FILE` writes size-rotated JSONL with bounded retention. Writes are serialized with rotation, and disk failures are reported distinctly on stderr without stopping the poller.

## Deployment & Rollback

### Assumptions
- Node.js version 20+.
- `CURSOR_FILE` exists on a persistent volume. If the deployment is ephemeral and restarts frequently, mounting a volume for `data/cursor.json` ensures the bot doesn't spam recent events on every restart.
- If `/broadcast` confirmations must survive restarts, `BROADCAST_CONFIRMATION_STORE_PATH` must also point at a persistent volume.

### Rollback
- Since the bot is read-only, rolling back to an older version requires no on-chain coordination or state migrations.
- **Cursor Compatibility**: If a rollback happens, ensure the older version is compatible with the format in `CURSOR_FILE` (a JSON object with `ledger` and `id`). If incompatible, clear the cursor file for a cold start lookback.