# Dead-Letter Queue (DLQ)

Operational reference for inspecting, understanding, and managing failed Telegram notifications stored in the dead-letter queue.

## Overview

The Mimir Telegram notifier prioritizes the Stellar blockchain as the authoritative source of truth. Telegram delivery is deliberately decoupled and lossy: when a notification fails to send after in-cycle retries, the poller does not hold back the chain cursor, as wedging the cursor on a delivery failure would halt ingestion or cause unbounded backlogs.

Instead, failed sends are persisted locally to disk in the file configured by `DEAD_LETTER_FILE` (defaults to `./data/dead-letter.json`). On subsequent poll cycles, parked messages are automatically replayed in chronological order once Telegram delivery succeeds again.

If `DEAD_LETTER_FILE` is unset or empty, persistence is disabled and the queue operates purely in memory.

---

## File Format & Entry Fields

The dead-letter file is written atomically (via a write-to-temporary-file and rename pattern) and adheres to the following JSON schema:

```json
{
  "version": 1,
  "updatedAt": "2026-10-18T15:00:00.000Z",
  "entries": [
    {
      "id": "market:123456:MarketCreated:a1b2c3d4",
      "enqueuedAt": "2026-10-18T14:59:50.000Z",
      "source": "market",
      "ledger": 123456,
      "eventName": "MarketCreated",
      "text": "Formatted MarkdownV2 message body…",
      "attempts": 1,
      "lastError": "Telegram API 429: Too Many Requests: retry after 5"
    }
  ]
}
```

### Top-Level Fields (`DeadLetterFile`)

* `version` (`number`): Format version integer (currently `1`).
* `updatedAt` (`string`): ISO 8601 timestamp of when the file was last written or modified.
* `entries` (`DeadLetterEntry[]`): List of parked dead-letter items.

### Entry Fields (`DeadLetterEntry`)

Each entry in `entries` mirrors the `DeadLetterEntry` TypeScript interface defined in [`src/deadLetter.ts`](file:///c:/Users/HP/drips/work/telegram-bot/src/deadLetter.ts):

* `id` (`string`): Stable unique identifier within the queue (see [Entry ID Generation](#entry-id-generation-makeentryid)).
* `enqueuedAt` (`string`): ISO 8601 timestamp recording when the failure was first enqueued.
* `source` (`string`): Originating contract source name (e.g. `market` or `squad`).
* `ledger` (`number`): Stellar ledger sequence number where the event occurred.
* `eventName` (`string`): Contract event topic/name (e.g. `MarketCreated`, `BetPlaced`, `Resolved`).
* `text` (`string`): The formatted Telegram `MarkdownV2` message body. Bounded and truncated to at most 4,000 characters (`TEXT_TRUNCATE`).
* `attempts` (`number`): The number of delivery attempts made so far (starts at `1` upon initial enqueue and increments on each failed replay).
* `lastError` (`string | null`): Scrubbed, redacted error message from the most recent send failure, truncated to at most 200 characters (`ERROR_TRUNCATE`). Sensitive secrets like `BOT_TOKEN` are scrubbed via `safeErrorMessage`.

---

## Entry ID Generation (`makeEntryId`)

Entry IDs are generated deterministically by the `makeEntryId` function in [`src/deadLetter.ts`](file:///c:/Users/HP/drips/work/telegram-bot/src/deadLetter.ts):

$$\text{id} = \text{source} : \text{ledger} : \text{eventName} : \text{shortHash}(\text{text})$$

Format:
```
<source>:<ledger>:<eventName>:<shortHash(text)>
```

* `shortHash(text)`: A 32-bit non-cryptographic polynomial hash (`h * 31 + charCode`) formatted as an 8-character zero-padded hexadecimal string.
* **Deduplication**: If an identical event failure is enqueued again while an entry with the same ID is already present in the queue, a duplicate entry is not added. Instead, the existing entry's `attempts` counter increments and `lastError` updates with the latest failure.

---

## Retry Behaviour, Flushes, and Limits

### Automatic Replay (`flush`)

* Parked messages are replayed during the poll cycle before processing newly scanned events, allowing the channel to catch up in chronological order.
* Flushes are rate-budgeted: at most `MAX_NOTIFICATIONS_PER_CYCLE` (default `20`) messages are replayed per cycle. This prevents recovery bursts from flooding Telegram channels or triggering Telegram rate limits.
* Replays use `sendWithRetry` with exponential backoff and redaction.

### Bounds and Poison Entry Drops

The queue is strictly bounded across every dimension:

1. **Depth Limit (`DEAD_LETTER_MAX` / `maxEntries`)**:
   * Configured via `DEAD_LETTER_MAX` (default `100`).
   * When enqueuing a new entry into a queue that has reached `maxEntries`, the **oldest** entry is dropped and counted (`dropped` counter). This prevents permanently failing sends from expanding the file indefinitely.
2. **Attempt Limit (`DEAD_LETTER_MAX_ATTEMPTS` / `maxAttempts`)**:
   * Configured via `DEAD_LETTER_MAX_ATTEMPTS` (default `10`).
   * If a message fails replay `maxAttempts` times, it is deemed a "poison entry" (e.g. invalid formatting rejected by Telegram) and is dropped from the queue.
3. **Payload Truncation**:
   * Message text is truncated to 4,000 characters.
   * Error messages are scrubbed of secrets and truncated to 200 characters.

---

## Operator Inspection with `jq`

Because the file contains standard JSON, operators can safely inspect queue status and contents on host or container storage using `jq`.

### 1. Check queue depth and last updated time
```bash
jq '{version, updatedAt, depth: (.entries | length)}' data/dead-letter.json
```

### 2. View summary of all parked messages (source, ledger, event, attempts, and error)
```bash
jq '.entries[] | {id, source, ledger, eventName, attempts, lastError, enqueuedAt}' data/dead-letter.json
```

### 3. Identify messages near the maximum retry limit (at risk of being dropped)
```bash
jq '.entries[] | select(.attempts >= 8)' data/dead-letter.json
```

### 4. View unique errors causing send failures
```bash
jq -r '.entries[].lastError' data/dead-letter.json | sort | uniq -c
```

### 5. Inspect the full message body of a specific entry
```bash
jq -r '.entries[] | select(.id == "market:123456:MarketCreated:a1b2c3d4") | .text' data/dead-letter.json
```

---

## When to Delete or Clear the File

Under normal operation, **operators should not need to manually delete the file**. The dead-letter queue will drain automatically once Telegram connectivity is restored, and poison or overflow messages are dropped gracefully per the limits.

However, manual deletion or clearing of `DEAD_LETTER_FILE` is appropriate in the following circumstances:

1. **Permanent Bot Configuration Change / Channel Abandonment**:
   * If the bot token was revoked and replaced with a bot for a different chat or the target channel was permanently deleted, old parked messages may continuously fail to deliver.
2. **Unrecoverable Poison Backlog**:
   * If bad formatting or invalid Markdown payloads bypassed validation and fill the queue, and you prefer not to wait for entries to exhaust `DEAD_LETTER_MAX_ATTEMPTS`.
3. **Corrupt Dead-Letter File**:
   * If manual edits or disk corruption make `data/dead-letter.json` unparseable (the bot logs `[dead-letter] unreadable queue at ...; starting empty`), removing the corrupt file allows a fresh clean file to be written.

### Safe File Clearing Procedure

> [!WARNING]
> Always verify the bot's status and ensure you are not clearing the cursor file (`cursor.json`). Only touch `dead-letter.json`.

1. **Option A: Stop the bot, remove the file, and restart**:
   ```bash
   rm -f data/dead-letter.json
   ```
   The notifier will initialize an empty queue upon the next cycle.

2. **Option B: Reset contents while running**:
   Write a valid empty schema so the next poll cycle loads an empty queue cleanly:
   ```bash
   echo '{"version":1,"updatedAt":"'$(date -u +"%Y-%m-%dT%H:%M:%SZ")'","entries":[]}' > data/dead-letter.json
   ```

---

## CLI Inspection and Management (`npm run dlq`)

The `dlq` CLI gives operators an offline way to inspect, purge, and plan replays without
touching Telegram or mutating chain state.

```
npm run dlq -- <subcommand> [--file PATH] [--json]
```

All subcommands redact raw chat IDs and scrub secrets from their output.

### `list` — Show all parked entries

```bash
npm run dlq -- list
npm run dlq -- list --chat-id "-1001234567890"
npm run dlq -- list --json
```

Prints every entry in the queue with its ID, source, ledger, event name, attempt count, and
redacted last error. `--json` emits machine-readable JSON.

### `show <id>` — Inspect a single entry

```bash
npm run dlq -- show market:123456:MarketCreated:a1b2c3d4
```

Prints the full entry including the formatted message body.

### `purge` — Remove entries (dry-run by default)

```bash
# Dry-run: see what would be removed without changing anything
npm run dlq -- purge

# Commit: atomically remove all entries
npm run dlq -- purge --yes

# Remove only entries older than 2 days
npm run dlq -- purge --older-than 2d --yes
```

Without `--yes` the command prints what it would do and exits without touching the file.

### `replay` — Dry-run replay plan grouped by destination

```bash
npm run dlq -- replay
npm run dlq -- replay --chat-id "-1001234567890"
npm run dlq -- replay --json
```

Reads the queue and produces a plan showing which entries would be sent on the next replay
cycle, grouped by destination (redacted chat ID). No Telegram requests are made and the
queue file is not modified.

Each entry is classified as:

- **eligible** — `attempts < maxAttempts`; would be replayed.
- **ineligible** — `attempts >= maxAttempts`; already exhausted and would be dropped on the
  next flush rather than sent.

Example output:

```
[dlq] replay plan (dry-run): 3 eligible, 1 ineligible, 4 total — no Telegram requests made

  destination: ***4567890
    eligible (3):
      market:101:claim_created:a1b2c3d4  source=market  ledger=101  event=claim_created  attempts=1  reason=attempt 1/9 remaining
      market:102:claim_created:b2c3d4e5  source=market  ledger=102  event=claim_created  attempts=2  reason=attempt 2/9 remaining
      squad:200:claim_cancelled:c3d4e5f6  source=squad   ledger=200  event=claim_cancelled attempts=1  reason=attempt 1/9 remaining
    ineligible (1):
      market:50:claim_created:00000001   source=market  ledger=50   event=claim_created  attempts=10 reason=exhausted after 10 attempt(s) (max 10)
```

The `replay` subcommand does not accept `--yes` or `--older-than`; it is always a read-only
plan. To actually flush the queue, the bot must be running (flushes happen automatically at
the start of each poll cycle).
