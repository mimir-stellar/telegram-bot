# Delivery Guarantees

This document specifies the exact event-ordering, deduplication, cursor-commit, dead-letter queue (DLQ), and crash-recovery guarantees provided by the Mimir Telegram bot. Every guarantee and failure outcome below is backed by a concrete code path and/or named test in the repository.

---

## 1. Core Delivery Model

The Stellar Soroban ledger is the authoritative record of all contract activity; Telegram notifications are an asynchronous, best-effort projection ([`src/poller.ts`](../src/poller.ts#L5-L7)). Because the Telegram Bot API does not support idempotency keys or atomic multi-system transactions with local cursor persistence, the bot combines:

1. **Bounded at-least-once RPC scanning with sliding-window deduplication**: Soroban `getEvents` pagination and cursor resumption are inclusive at cursor boundaries. To prevent duplicate announcements during normal operation and across clean restarts, the bot tracks recently seen event identities in a per-contract FIFO window (`EventDedupWindow`, configured by `EVENT_DEDUP_WINDOW`, default `256`) and persists those keys in `CURSOR_FILE` (`recentEventIds`) ([`src/dedup.ts`](../src/dedup.ts#L50-L51), [`src/poller.ts`](../src/poller.ts#L683-L685)).
2. **At-most-once cursor advancement per scan batch, backed by a persistent dead-letter queue**: Once a target contract's event batch is processed in `notify()`, the in-memory cursor advances to `scan.lastCursor` regardless of individual Telegram send failures ([`src/poller.ts`](../src/poller.ts#L2214-L2233)). Messages that exhaust in-cycle retries (`sendWithRetry`) are parked in `DEAD_LETTER_FILE` (when configured, default `./data/dead-letter.json`) and replayed at the start of subsequent poll cycles (`flushDeadLetter`) ([`src/poller.ts`](../src/poller.ts#L1796-L1805), [`src/deadLetter.ts`](../src/deadLetter.ts#L218-L264)).
3. **Fail-forward bounds over unbounded blocking**: Under extreme backlogs, prolonged outages, or graceful shutdown drains, the bot prioritizes forward cursor progress and bounded Telegram traffic over guaranteed delivery of every historical event ([`src/poller.ts`](../src/poller.ts#L1666-L1670), [`src/poller.ts`](../src/poller.ts#L1725-L1760), [`src/poller.ts`](../src/poller.ts#L1944-L1988)).

---

## 2. Event Ordering Guarantees

### 2.1 Deterministic Per-Contract Chain Ordering (`compareEvents` / `sortEvents`)

Soroban RPC nodes do not guarantee strict intra-ledger ordering across multi-page `getEvents` responses. Before returning decoded events for a contract, `readContractEvents` runs `sortEvents(dedupeEvents(decoded))` ([`src/stellar/events.ts`](../src/stellar/events.ts#L387)).

`compareEvents` ([`src/stellar/decode.ts`](../src/stellar/decode.ts#L1280-L1291)) and `sortEvents` ([`src/stellar/decode.ts`](../src/stellar/decode.ts#L1297-L1302)) order events by a strict 6-level comparator:

1. **`ledger` (ascending)**: Parsed via `toLedger` ([`src/stellar/decode.ts`](../src/stellar/decode.ts#L1249-L1254)). Missing, non-finite, or negative ledger values coerce to `0`.
   - *Evidence*: [`src/stellar/decode.ts`](../src/stellar/decode.ts#L1281-L1282); tests `"orders events across ledgers in ascending ledger order"` and `"handles missing or malformed ledger values safely"` in [`tests/ordering.test.mjs`](../tests/ordering.test.mjs#L11-L26), [`tests/ordering.test.mjs`](../tests/ordering.test.mjs#L162-L174).
2. **`transactionIndex` (ascending, known before unknown)**: Extracted by `extractOrderField` ([`src/stellar/decode.ts`](../src/stellar/decode.ts#L1119-L1153)) from numeric fields (`txIndex`, `transactionIndex`, `txnIndex`, or nested `transaction.*`) or parsed from the middle segment of a SEP-0035 Total Order ID (`<ledger-packed>-<txIndex>-<opIndex>`). Ranked via `rankPosition` ([`src/stellar/decode.ts`](../src/stellar/decode.ts#L1260-L1265)), which maps `null` (unknown) to `Number.MAX_SAFE_INTEGER` so events with known indices always sort *before* events with missing metadata, without inventing fake coordinates.
   - *Evidence*: [`src/stellar/decode.ts`](../src/stellar/decode.ts#L1284-L1285); tests `"orders events in the same ledger by transactionIndex"` and `"places events with known ordering metadata before events missing it"` in [`tests/ordering.test.mjs`](../tests/ordering.test.mjs#L28-L43), [`tests/ordering.test.mjs`](../tests/ordering.test.mjs#L131-L148).
3. **`operationIndex` (ascending, known before unknown)**: Extracted from explicit operation fields (`opIndex`, `operationIndex`, `operation.*`) or 3-part TOIDs (`extractOrderField`, [`src/stellar/decode.ts`](../src/stellar/decode.ts#L1142-L1152)) and ranked via `rankPosition`. Note that 2-part RPC event IDs (`<toid>-<eventIndex>`) are *not* treated as operation indices ([`src/stellar/decode.ts`](../src/stellar/decode.ts#L1149-L1151)).
   - *Evidence*: [`src/stellar/decode.ts`](../src/stellar/decode.ts#L1287-L1288); tests `"orders events in the same transaction by operationIndex"` and `"parses 3-part TOID event id for tx/op index when explicit fields are absent"` in [`tests/ordering.test.mjs`](../tests/ordering.test.mjs#L45-L60), [`tests/ordering.test.mjs`](../tests/ordering.test.mjs#L98-L115).
4. **`eventId` (lexicographical ascending)**: Compared via `compareStrings(a.eventId, b.eventId)` ([`src/stellar/decode.ts`](../src/stellar/decode.ts#L1270-L1275), [`src/stellar/decode.ts`](../src/stellar/decode.ts#L1290)). Because Soroban zero-pads TOIDs (`0000110000-0001` < `0000110000-0002`), lexicographical order matches emission order within the same operation.
   - *Evidence*: [`src/stellar/decode.ts`](../src/stellar/decode.ts#L1290); test `"falls back to eventId ordering when tx/op indices are equal"` in [`tests/ordering.test.mjs`](../tests/ordering.test.mjs#L62-L77).
5. **`txHash` (lexicographical ascending)**: Deterministic tie-breaker when `eventId` is absent or identical ([`src/stellar/decode.ts`](../src/stellar/decode.ts#L1291)).
   - *Evidence*: [`src/stellar/decode.ts`](../src/stellar/decode.ts#L1291); test `"falls back to txHash ordering when eventId is absent"` in [`tests/ordering.test.mjs`](../tests/ordering.test.mjs#L79-L96).
6. **Input sequence stability**: `sortEvents` preserves original array order (`a.index - b.index`) when all five chain keys compare equal ([`src/stellar/decode.ts`](../src/stellar/decode.ts#L1298-L1301)).
   - *Evidence*: [`src/stellar/decode.ts`](../src/stellar/decode.ts#L1297-L1302); test `"sortEvents is stable when all ordering keys are identical"` in [`tests/ordering.test.mjs`](../tests/ordering.test.mjs#L150-L160).

### 2.2 Cross-Target and Replay Ordering Within a Poll Cycle

Within a single `cycle()` execution ([`src/poller.ts`](../src/poller.ts#L1994-L2329)):

1. **Dead-letter queue replay runs first**: If `DEAD_LETTER_FILE` is configured and non-empty, `flushDeadLetter` replays queued entries in FIFO (oldest-enqueued first) order before any new contract events are scanned ([`src/poller.ts`](../src/poller.ts#L1829-L1850), [`src/poller.ts`](../src/poller.ts#L2039), [`src/deadLetter.ts`](../src/deadLetter.ts#L272-L320)).
   - *Evidence*: [`src/poller.ts`](../src/poller.ts#L2039); test `"poller replays a failed send from the DLQ on the next cycle"` in [`tests/poller-dlq.test.mjs`](../tests/poller-dlq.test.mjs#L62-L105).
2. **Sequential target scanning (`market` then `squad`)**: Targets are defined in fixed order (`market` when `MARKET_CONTRACT_ID` is set, followed by `squad` when `SQUAD_CONTRACT_ID` is set) and iterated sequentially ([`src/poller.ts`](../src/poller.ts#L1314-L1321), [`src/poller.ts`](../src/poller.ts#L2045)). All notifications for `market` in a cycle are sent before `squad` is scanned.
   - *Evidence*: [`src/poller.ts`](../src/poller.ts#L1314-L1321), [`src/poller.ts`](../src/poller.ts#L2045); test `"runOnce sends notification for decoded market event and updates status"` in [`tests/poller.test.mjs`](../tests/poller.test.mjs#L71-L103).
3. **Sequential in-order delivery per target**: `notify()` iterates the sorted `scan.events` array one by one, awaiting `sendWithRetry` and sleeping `INTER_SEND_DELAY_MS` (default `1500ms`) between consecutive sends ([`src/poller.ts`](../src/poller.ts#L1664-L1825)).

---

## 3. Deduplication Window (`eventKey` & `EventDedupWindow`)

### 3.1 Why Deduplication Is Required

Soroban RPC `getEvents` pagination and cursor resumption can return overlapping boundary events across pages within a single scan or across consecutive poll cycles when resuming from `cursor` or `lastEventLedger` ([`src/dedup.ts`](../src/dedup.ts#L9-L14), [`src/stellar/events.ts`](../src/stellar/events.ts#L219-L231)).

### 3.2 Key Derivation Priority (`eventKey`)

`eventKey(event)` ([`src/dedup.ts`](../src/dedup.ts#L151-L166)) computes a deterministic identity string using the following fallback hierarchy:

1. **`event.id` (primary)**: Non-empty string matching the Soroban RPC Total Order ID (`<ledger-packed>-<index>`), unique per emitted event on-chain ([`src/dedup.ts`](../src/dedup.ts#L155)).
2. **`event.eventId` (decoded alias)**: Used when `eventKey` is called on an already-decoded `ChainEvent` ([`src/dedup.ts`](../src/dedup.ts#L156), [`src/stellar/decode.ts`](../src/stellar/decode.ts#L1313-L1327)).
3. **Composite fallback (`v2:<ledger>:<txHash>:<txIndex>:<opIndex>:<topicDigest>`)**: Constructed only when `txHash` is a non-empty string *and* `event.topic` is a non-empty array whose elements can all be deterministically serialized (`encodeTopicSegment`) into a 16-hex-character SHA-256 digest (`topicDigest`, `TOPIC_DIGEST_CHARS = 16`) ([`src/dedup.ts`](../src/dedup.ts#L96-L144), [`src/dedup.ts`](../src/dedup.ts#L158-L165)). Missing `txIndex` or `opIndex` render as `_`.
4. **`null` (undeduplicated pass-through)**: Returned when `event` is nullish, lacks both `id`/`eventId` and a valid `txHash` + `topic` array, or contains an opaque non-serializable topic object ([`src/dedup.ts`](../src/dedup.ts#L121-L122), [`src/dedup.ts`](../src/dedup.ts#L158-L161)). Returning `null` ensures distinct events in the same transaction are never collapsed onto a coarse ledger/txHash key.
   - *Evidence*: [`src/dedup.ts`](../src/dedup.ts#L151-L166); tests `"eventKey uses raw rpc id when present"`, `"eventKey falls back to decoded eventId field"`, `"eventKey builds composite key with topic digest when id is missing"`, `"eventKey distinguishes two events in the same tx with different topics"`, and `"eventKey returns null when id is missing and topics are absent or empty"` in [`tests/dedup.test.mjs`](../tests/dedup.test.mjs#L11-L59).

### 3.3 Sliding Window Semantics (`EventDedupWindow` & `EVENT_DEDUP_WINDOW`)

`EventDedupWindow` ([`src/dedup.ts`](../src/dedup.ts#L174-L225)) wraps a JavaScript `Set` (which preserves insertion order) per contract target:

- **Default capacity**: `DEFAULT_DEDUP_WINDOW = 256` keys per contract, configurable via `EVENT_DEDUP_WINDOW` ([`src/dedup.ts`](../src/dedup.ts#L50), [`src/config.ts`](../src/config.ts#L569-L574)).
- **FIFO eviction**: When adding a new key exceeds `capacity`, the oldest inserted key (`this.order.values().next().value`) is evicted ([`src/dedup.ts`](../src/dedup.ts#L197-L202)). Re-observing an already-present key via `has()` or `add()` returns `true` (duplicate) without reinserting or exceeds-cap evicting ([`src/dedup.ts`](../src/dedup.ts#L194-L196)).
- **Oversized key protection**: Keys longer than `MAX_KEY_CHARS = 512` return `false` from `has()` and `add()` without being stored in the window, preventing adversarial inputs from bloating `cursor.json` while never suppressing legitimate notifications ([`src/dedup.ts`](../src/dedup.ts#L56), [`src/dedup.ts`](../src/dedup.ts#L186-L193)).
- **Disabling deduplication (`EVENT_DEDUP_WINDOW=0`)**: Setting `capacity = 0` disables retention (`has()` and `add()` always return `false`) ([`src/dedup.ts`](../src/dedup.ts#L186), [`src/dedup.ts`](../src/dedup.ts#L193)).
- **Two-stage filtering during a scan**:
  1. `paginatedGetEvents` seeds an `EventDedupWindow` with the target's persisted `seenEventIds` and drops duplicate raw RPC events across pages (`duplicatesSkipped`) while still advancing `lastCursor` past the page's final raw event ([`src/stellar/events.ts`](../src/stellar/events.ts#L230-L231), [`src/stellar/events.ts`](../src/stellar/events.ts#L291-L303)).
  2. `readContractEvents` applies `dedupeEvents` ([`src/stellar/decode.ts`](../src/stellar/decode.ts#L1313-L1327)) across decoded events before sorting ([`src/stellar/events.ts`](../src/stellar/events.ts#L387)).
- **Persistence across restarts**: In `cycle()`, newly observed IDs (`scan.seenEventIds`) are recorded into the target's `dedupWindow` ([`src/poller.ts`](../src/poller.ts#L2192)) and serialized as `recentEventIds: current.dedupWindow.toArray()` in `CURSOR_FILE` ([`src/poller.ts`](../src/poller.ts#L1433)). On startup, `normalizeSavedTarget` restores `recentEventIds` into a fresh `EventDedupWindow(dedupWindowSize, recentEventIds)` ([`src/poller.ts`](../src/poller.ts#L683-L685)).
- **Eviction boundary trade-off**: If a contract emits more than `EVENT_DEDUP_WINDOW` (`256`) events and the RPC later replays an event older than the most recent `256` keys, that older key will have been evicted and the event **will be delivered again (duplicate)**.
- *Evidence*:
  - [`src/dedup.ts`](../src/dedup.ts#L174-L225); tests `"EventDedupWindow tracks seen keys and evicts oldest in FIFO order"`, `"EventDedupWindow with capacity 0 disables deduplication"`, `"EventDedupWindow serialises and restores order via toArray / constructor"`, and `"EventDedupWindow rejects oversized keys without storing them"` in [`tests/dedup.test.mjs`](../tests/dedup.test.mjs#L71-L129).
  - [`src/stellar/events.ts`](../src/stellar/events.ts#L291-L315); tests `"readContractEvents drops duplicate event IDs across pages within one cycle"`, `"readContractEvents suppresses events already present in seenEventIds from prior cycle"`, and `"all-duplicate page still advances lastCursor to the page tail"` in [`tests/page-dedup.test.mjs`](../tests/page-dedup.test.mjs#L42-L162).
  - [`src/poller.ts`](../src/poller.ts#L683-L685); tests `"poller suppresses boundary event re-served on next cycle and persists recentEventIds"` and `"restarted poller loads recentEventIds from cursor file and does not re-notify"` in [`tests/dedup.test.mjs`](../tests/dedup.test.mjs#L131-L224).

---

## 4. Cursor Commit Policy & Dead-Letter Queue

### 4.1 In-Cycle Send Retries (`sendWithRetry`)

When `notify()` sends a formatted event to Telegram (`sendMessage`), `sendWithRetry` ([`src/poller.ts`](../src/poller.ts#L1562-L1651)) wraps each call with:

- **Per-attempt timeout**: `withTimeout` aborts stalled calls after `sendTimeoutMs` (`TELEGRAM_SEND_TIMEOUT_MS`, default `10_000ms` in [`src/config.ts`](../src/config.ts#L636-L640); fallback `DEFAULT_SEND_TIMEOUT_MS = 15_000ms` in [`src/poller.ts`](../src/poller.ts#L78)).
- **Retry budget**: Up to `DEFAULT_MAX_SEND_RETRIES = 3` retries (`4` total attempts) ([`src/poller.ts`](../src/poller.ts#L74), [`src/poller.ts`](../src/poller.ts#L1579)).
- **Backoff & rate-limit handling**: Honors Telegram HTTP 429 `Retry-After` / `parameters.retry_after` headers (capped at `MAX_RETRY_AFTER_MS = 3_600_000ms` / 1 hour) or falls back to exponential backoff (`1000ms` -> `2000ms` -> `4000ms`, capped at `SEND_BACKOFF_MAX_MS = 10_000ms`) ([`src/poller.ts`](../src/poller.ts#L75-L77), [`src/poller.ts`](../src/poller.ts#L857-L905)).
- *Evidence*: [`src/poller.ts`](../src/poller.ts#L1562-L1651); tests `"Retries transient send failures and succeeds without advancing cursor early"` and `"Honors Telegram Retry-After on 429 responses"` in [`tests/poller_resilience.test.mjs`](../tests/poller_resilience.test.mjs#L123-L185).

### 4.2 Cursor Advancement Policy

For each target in `cycle()` ([`src/poller.ts`](../src/poller.ts#L2192-L2238)):

1. **Before `notify()`**: `scan.seenEventIds` are added to `current.dedupWindow` in memory ([`src/poller.ts`](../src/poller.ts#L2192)).
2. **During `notify()`**: Filtered events (`!shouldNotify`), formatting errors, and events exceeding `MAX_NOTIFICATIONS_PER_CYCLE` (default `20`) are skipped (`eventsSkipped`) ([`src/poller.ts`](../src/poller.ts#L1682-L1760)). Events whose `sendWithRetry` fails all attempts increment `sendFailures` and are enqueued into the dead-letter queue (if enabled) ([`src/poller.ts`](../src/poller.ts#L1794-L1805)).
3. **After `notify()`**: In-memory `current.lastEventLedger` advances to `Math.max(current.lastEventLedger, scan.lastLedger)` and `current.cursor` updates to `scan.lastCursor` **even when `delivery.failed > 0 || delivery.skipped > 0`** ([`src/poller.ts`](../src/poller.ts#L2214-L2238)). If `delivery.failed > 0 || delivery.skipped > 0`, the poller logs `cursor_advanced_with_partial_delivery` ([`src/poller.ts`](../src/poller.ts#L2223-L2232)).
4. **End-of-cycle atomic commit (`saveCursors("cycle")`)**: In the `finally` block of `cycle()`, if any target mutated cursor state (`cursorDirty || status.persistence.pendingFlush`), `saveCursors("cycle")` writes the JSON payload to `${CURSOR_FILE}.tmp`, atomically renames it to `CURSOR_FILE`, and copies the previous live file (or new file on first write) to `${CURSOR_FILE}.bak` ([`src/poller.ts`](../src/poller.ts#L1427-L1469), [`src/poller.ts`](../src/poller.ts#L2315-L2328)).
- *Evidence*:
  - [`src/poller.ts`](../src/poller.ts#L2214-L2238); test `"Continues notifying remaining events when one event permanently fails"` in [`tests/poller_resilience.test.mjs`](../tests/poller_resilience.test.mjs#L187-L220).
  - [`src/poller.ts`](../src/poller.ts#L1725-L1760); test `"Caps notifications per cycle and skips overflow without failing"` in [`tests/poller_resilience.test.mjs`](../tests/poller_resilience.test.mjs#L222-L260).
  - [`src/poller.ts`](../src/poller.ts#L1427-L1469); tests `"saveCursors creates a .bak copy after the second save"` and `"saveCursors leaves .json intact and cleans .tmp when rename fails"` in [`tests/cursor-backup.test.mjs`](../tests/cursor-backup.test.mjs#L50-L96).

### 4.3 Dead-Letter Queue (`src/deadLetter.ts`)

When `DEAD_LETTER_FILE` is configured (default `./data/dead-letter.json`; disabled if set to `""` or `"none"` in [`src/config.ts`](../src/config.ts#L604-L611)), `createDeadLetterQueue` ([`src/deadLetter.ts`](../src/deadLetter.ts#L172-L337)) provides bounded at-least-once recovery for failed Telegram deliveries without holding back the chain cursor:

- **Deterministic in-queue deduplication**: Each entry ID is `sha256("${source}:${ledger}:${eventName}:${text}").slice(0, 16)` (`makeEntryId`, [`src/deadLetter.ts`](../src/deadLetter.ts#L102-L109)). Re-enqueuing an identical undelivered message updates `attempts`, `lastError`, and `lastAttemptAt` in place rather than duplicating the entry ([`src/deadLetter.ts`](../src/deadLetter.ts#L225-L232)).
- **Capacity cap (`DEAD_LETTER_MAX`)**: Default `100` (`DEAD_LETTER_MAX_ENTRIES`, [`src/deadLetter.ts`](../src/deadLetter.ts#L26), [`src/config.ts`](../src/config.ts#L613-L618)). When full, `enqueue()` evicts the **oldest** entry (`entries.shift()`, incrementing `evicted`) to make room for the newest failure ([`src/deadLetter.ts`](../src/deadLetter.ts#L235-L246)). Evicted entries are **permanently missed**.
- **Attempt cap (`DEAD_LETTER_MAX_ATTEMPTS`)**: Default `10` ([`src/deadLetter.ts`](../src/deadLetter.ts#L29), [`src/config.ts`](../src/config.ts#L619-L624)). During `replay()`, if an entry fails again and reaches `entry.attempts >= maxAttempts`, it is removed (`permanentlyFailed`) so a poison message cannot block the queue forever ([`src/deadLetter.ts`](../src/deadLetter.ts#L301-L315)). Dropped poison entries are **permanently missed**.
- **Replay budget (`MAX_NOTIFICATIONS_PER_CYCLE`)**: `flushDeadLetter` replays at most `maxNotificationsPerCycle` (default `20`) entries at the start of each cycle ([`src/poller.ts`](../src/poller.ts#L1834)). Remaining entries stay on disk for future cycles.
- **Atomic persistence & corruption quarantine**: Every `enqueue()` and `replay()` persists `${DEAD_LETTER_FILE}.tmp` and renames it over `DEAD_LETTER_FILE` ([`src/deadLetter.ts`](../src/deadLetter.ts#L142-L166)). If `DEAD_LETTER_FILE` is corrupt on load, it is quarantined to `${DEAD_LETTER_FILE}.corrupt.<timestamp>` and the queue starts empty (losing whatever was inside the corrupt file) ([`src/deadLetter.ts`](../src/deadLetter.ts#L187-L209)).
- *Evidence*:
  - [`src/deadLetter.ts`](../src/deadLetter.ts#L172-L337); tests `"enqueue persists entry and reload recovers it across instances"`, `"enqueue deduplicates identical notifications by updating attempts"`, `"enqueue evicts oldest entry when maxEntries is exceeded"`, `"replay delivers queued entries and removes them from disk"`, `"replay drops entry after reaching maxAttempts"`, and `"corrupt dead-letter file is quarantined and queue starts empty"` in [`tests/deadLetter.test.mjs`](../tests/deadLetter.test.mjs#L27-L163).
  - [`src/poller.ts`](../src/poller.ts#L1796-L1850); tests `"poller enqueues failed Telegram send into DLQ and advances cursor"`, `"poller replays a failed send from the DLQ on the next cycle"`, and `"poller drops DLQ entry after maxAttempts consecutive cycle failures"` in [`tests/poller-dlq.test.mjs`](../tests/poller-dlq.test.mjs#L19-L157).

---

## 5. Crash Points and Their Effects

A single poll cycle executes four distinct phases ([`src/poller.ts`](../src/poller.ts#L1994-L2329)):

```
[Phase 1: getHealth + DLQ Replay (flushDeadLetter)]
        │
        ▼
[Phase 2: Target Scan (enforceCursorWindow -> readContractEvents)]
        │
        ▼
[Phase 3: In-Memory Dedup Recording + Telegram Delivery (notify / sendWithRetry / DLQ enqueue)]
        │
        ▼
[Phase 4: In-Memory Cursor Advance -> End-of-Cycle Disk Commit (saveCursors("cycle"))]
```

### Crash Point A: During Phase 1 (DLQ Replay)
- **Effect**: `deadLetter.replay()` persists the updated queue to `DEAD_LETTER_FILE` only *after* the replay loop finishes (`if (mutated) await persist("replay")`, [`src/deadLetter.ts`](../src/deadLetter.ts#L318)).
  - If the process crashes cleanly or stops via `SIGTERM`, `replay()` checks `shouldStop()` before each entry, breaks early, and persists progress for entries already sent ([`src/deadLetter.ts`](../src/deadLetter.ts#L280-L282), [`src/deadLetter.ts`](../src/deadLetter.ts#L318)).
  - If the process dies abruptly (`SIGKILL` / power loss) *after* one or more DLQ entries were sent to Telegram but *before* `replay()` finishes and persists `DEAD_LETTER_FILE`, those sent DLQ entries remain on disk and **will be sent again (duplicate)** on restart.

### Crash Point B: During Phase 2 (RPC Scan, Before `notify()`)
- **Effect**: No Telegram messages for the current target have been sent, and `CURSOR_FILE` still holds the previous cycle's cursor and `recentEventIds`.
- **Outcome on restart**: The bot resumes from the previous persisted cursor. **No duplicate notifications and no missed notifications.**
- *Evidence*: [`src/poller.ts`](../src/poller.ts#L2045-L2190); test `"Recovers on next cycle after RPC failure without losing cursor progress"` in [`tests/poller_resilience.test.mjs`](../tests/poller_resilience.test.mjs#L90-L121).

### Crash Point C: Mid-Phase 3 (`SIGKILL` / Crash After Partial Telegram Sends, Before `saveCursors`)
- **Effect**: Suppose a target scan returns 5 events, Telegram `sendMessage` succeeds for events 1–2, and the process is killed (`SIGKILL`, OOM, or power loss) before `cycle()` reaches `saveCursors("cycle")` in the `finally` block ([`src/poller.ts`](../src/poller.ts#L2315-L2328)).
- **Outcome on restart**: Because `saveCursors("cycle")` only runs at the end of `cycle()`, neither the updated `cursor` nor the new `recentEventIds` for that cycle were written to `CURSOR_FILE`. On restart, the bot loads the prior cycle's `CURSOR_FILE` and re-scans:
  - Events 1–2 (already sent before the crash) are **duplicated**.
  - Events 3–5 (not yet sent before the crash) are **delivered normally** (not missed).

### Crash Point D: Graceful `SIGTERM` / `SIGINT` During Phase 3 (`notify()` Drain)
- **Effect**: When `SIGINT` or `SIGTERM` arrives, `src/index.ts` calls `poller.shutdown()` ([`src/index.ts`](../src/index.ts#L329-L360)), which calls `stop("shutdown")` (`status.stopping = true`) ([`src/poller.ts`](../src/poller.ts#L2528-L2547)).
  1. Inside `sendWithRetry`, any in-flight `sendMessage` finishes its current HTTP attempt, but if it fails or is sleeping between retries, `status.stopping` aborts further retry attempts immediately ([`src/poller.ts`](../src/poller.ts#L1593-L1595), [`src/poller.ts`](../src/poller.ts#L1622-L1624)).
  2. Inside `notify()`, before starting the next event in the batch (or after the inter-send delay), `if (status.stopping)` breaks out of the loop, increments `notificationsDropped` by the number of remaining unsent events in the batch, and logs `notify_aborted_on_shutdown` ([`src/poller.ts`](../src/poller.ts#L1666-L1670), [`src/poller.ts`](../src/poller.ts#L1814-L1819)).
  3. Despite aborting the remaining events in the batch, `cycle()` still advances `current.cursor = scan.lastCursor` and commits `saveCursors("cycle")` (and/or `saveCursors("shutdown")`) ([`src/poller.ts`](../src/poller.ts#L2214-L2221), [`src/poller.ts`](../src/poller.ts#L2566-L2572)).
- **Outcome on restart**: Events already sent before `SIGTERM` are **not duplicated** (`cursor.json` is flushed). Events in the current batch that were aborted due to `status.stopping` (or whose retry loop was cut short without DLQ configured) are **missed (dropped)** in order to bound shutdown latency within `SHUTDOWN_TIMEOUT_MS` (default `10_000ms`).
- *Evidence*: [`src/poller.ts`](../src/poller.ts#L1666-L1670), [`src/poller.ts`](../src/poller.ts#L2528-L2579); tests `"shutdown mid-notify finishes active send, drops remaining batch, and flushes cursor"` and `"shutdown mid-RPC-read waits for cycle then flushes cursor cleanly"` in [`tests/shutdown.test.mjs`](../tests/shutdown.test.mjs#L77-L162).

### Crash Point E: Graceful `SIGTERM` After `market` Completes While `squad` Is Hung Beyond `SHUTDOWN_TIMEOUT_MS`
- **Effect**: When `market` finishes Phase 3 in `cycle()`, `current.cursor` and `current.dedupWindow` are updated in memory and `status.persistence.pendingFlush = true` is set ([`src/poller.ts`](../src/poller.ts#L2220-L2221)). If `squad` then hangs in an RPC call past `SHUTDOWN_TIMEOUT_MS`, `poller.shutdown()` times out waiting for `activeCyclePromise` (`timedOut = true`), logs `poller_shutdown_timeout`, and immediately calls `saveCursors("shutdown")` because `status.persistence.pendingFlush` is `true` ([`src/poller.ts`](../src/poller.ts#L2555-L2572)).
- **Outcome on restart**: `market`'s advanced cursor and `recentEventIds` are safely persisted to `CURSOR_FILE` (**no duplicate `market` notifications**), while `squad` resumes from its prior cursor.
- *Evidence*: [`src/poller.ts`](../src/poller.ts#L2555-L2572); test `"shutdown times out when cycle exceeds timeoutMs and still flushes dirty cursor"` in [`tests/shutdown.test.mjs`](../tests/shutdown.test.mjs#L164-L214).

### Crash Point F: Second `SIGINT` / `SIGTERM` Force-Exit or Crash Mid-Disk-Write
- **Effect**: Sending a second `SIGINT`/`SIGTERM` while shutdown is in progress triggers immediate `process.exit(130)` / `process.exit(143)` in [`src/index.ts`](../src/index.ts#L335-L341).
  - Because `saveCursors`, `deadLetter.persist`, and `writeStatusFile` all write to `<file>.tmp` and call `fs.rename(<file>.tmp, <file>)` ([`src/poller.ts`](../src/poller.ts#L1443-L1445), [`src/deadLetter.ts`](../src/deadLetter.ts#L146-L148), [`src/poller.ts`](../src/poller.ts#L1479-L1480)), an abrupt exit during a write never leaves a half-written live JSON file.
  - Either the rename completed (new cursor is live) or it did not (previous cycle's cursor remains intact and a leftover `.tmp` file is overwritten on the next save).

---

## 6. Failure & Crash Scenarios Matrix

| # | Scenario | Cursor & DLQ State Effect | Notification Outcome | Backing Code Path & Named Test Evidence |
| :--- | :--- | :--- | :--- | :--- |
| **1** | **Overlapping boundary event returned across RPC pages or across poll cycles** | Filtered by `EventDedupWindow` (`seenEventIds` / `recentEventIds`); `lastCursor` still advances to page tail. | **Exact (no duplicate, no miss)** within the last `EVENT_DEDUP_WINDOW` (`256`) events per contract. | [`src/dedup.ts`](../src/dedup.ts#L174-L225), [`src/stellar/events.ts`](../src/stellar/events.ts#L291-L315)<br>Tests: `"readContractEvents drops duplicate event IDs across pages within one cycle"`, `"all-duplicate page still advances lastCursor to the page tail"` ([`tests/page-dedup.test.mjs`](../tests/page-dedup.test.mjs#L42-L162)); `"poller suppresses boundary event re-served on next cycle and persists recentEventIds"` ([`tests/dedup.test.mjs`](../tests/dedup.test.mjs#L131-L189)) |
| **2** | **RPC re-serves an event older than `EVENT_DEDUP_WINDOW` (`256`) or when `EVENT_DEDUP_WINDOW=0`** | Old key was evicted in FIFO order (or window is disabled); event is treated as unseen. | **Duplicate** notification for the re-served event. | [`src/dedup.ts`](../src/dedup.ts#L186-L202)<br>Tests: `"EventDedupWindow tracks seen keys and evicts oldest in FIFO order"`, `"EventDedupWindow with capacity 0 disables deduplication"` ([`tests/dedup.test.mjs`](../tests/dedup.test.mjs#L71-L108)) |
| **3** | **Event lacks RPC `id`/`eventId` and lacks serializable `txHash` + `topic` (or key > `512` chars)** | `eventKey` returns `null` (or `EventDedupWindow` rejects oversized key); not stored in `recentEventIds`. | **Delivered (never falsely suppressed)**; **duplicate** if RPC re-serves the same raw event. | [`src/dedup.ts`](../src/dedup.ts#L151-L166), [`src/dedup.ts`](../src/dedup.ts#L186-L193)<br>Tests: `"eventKey returns null when id is missing and topics are absent or empty"`, `"EventDedupWindow rejects oversized keys without storing them"` ([`tests/dedup.test.mjs`](../tests/dedup.test.mjs#L48-L59), [`tests/dedup.test.mjs`](../tests/dedup.test.mjs#L118-L129)) |
| **4** | **Transient Telegram send error (`429`, timeout, network reset) that recovers within 3 retries** | `sendWithRetry` backs off (or honors `Retry-After`) and succeeds; cursor advances normally; DLQ untouched. | **Exact (delayed in-cycle)**; no duplicate, no miss. | [`src/poller.ts`](../src/poller.ts#L1562-L1651)<br>Tests: `"Retries transient send failures and succeeds without advancing cursor early"`, `"Honors Telegram Retry-After on 429 responses"` ([`tests/poller_resilience.test.mjs`](../tests/poller_resilience.test.mjs#L123-L185)) |
| **5** | **Telegram send fails all 4 attempts in `sendWithRetry` (DLQ enabled, default)** | Cursor advances past the batch; failed message is persisted to `DEAD_LETTER_FILE` and replayed at the top of the next cycle (`flushDeadLetter`). | **Delayed (at-least-once via DLQ)**; delivered on a subsequent cycle once Telegram recovers. | [`src/poller.ts`](../src/poller.ts#L1796-L1850), [`src/deadLetter.ts`](../src/deadLetter.ts#L218-L320)<br>Tests: `"poller enqueues failed Telegram send into DLQ and advances cursor"`, `"poller replays a failed send from the DLQ on the next cycle"` ([`tests/poller-dlq.test.mjs`](../tests/poller-dlq.test.mjs#L19-L105)) |
| **6** | **Telegram send fails all 4 attempts with DLQ disabled (`DEAD_LETTER_FILE=""` or `"none"`)** | Cursor advances past the batch (`cursor_advanced_with_partial_delivery`); no DLQ file written. | **Missed** for the failed event; remaining events in the batch still delivered. | [`src/poller.ts`](../src/poller.ts#L1796-L1805), [`src/poller.ts`](../src/poller.ts#L2214-L2233)<br>Test: `"Continues notifying remaining events when one event permanently fails"` ([`tests/poller_resilience.test.mjs`](../tests/poller_resilience.test.mjs#L187-L220)) |
| **7** | **DLQ exceeds `DEAD_LETTER_MAX` (`100`) entries during prolonged Telegram outage** | `deadLetter.enqueue()` evicts the oldest queued entry (`evicted++`) to store the newest failure. | **Missed** for the evicted oldest entry; newest entries retained for replay. | [`src/deadLetter.ts`](../src/deadLetter.ts#L235-L246)<br>Test: `"enqueue evicts oldest entry when maxEntries is exceeded"` ([`tests/deadLetter.test.mjs`](../tests/deadLetter.test.mjs#L67-L87)) |
| **8** | **DLQ entry fails `DEAD_LETTER_MAX_ATTEMPTS` (`10`) total attempts across cycles** | `deadLetter.replay()` removes the entry (`permanentlyFailed++`) and logs `dead_letter_dropped_max_attempts`. | **Missed** for the poison entry; subsequent DLQ entries are unblocked. | [`src/deadLetter.ts`](../src/deadLetter.ts#L301-L315)<br>Tests: `"replay drops entry after reaching maxAttempts"` ([`tests/deadLetter.test.mjs`](../tests/deadLetter.test.mjs#L112-L139)); `"poller drops DLQ entry after maxAttempts consecutive cycle failures"` ([`tests/poller-dlq.test.mjs`](../tests/poller-dlq.test.mjs#L107-L157)) |
| **9** | **Clean restart (`SIGTERM`/`SIGINT`) between poll cycles** | `CURSOR_FILE` has the latest `cursor`, `lastEventLedger`, and `recentEventIds`. Next start resumes from `cursor` (`resumeMode: "cursor"`). | **Exact (no duplicate, no miss)** as long as downtime < RPC retention window. | [`src/poller.ts`](../src/poller.ts#L2096-L2147), [`src/stellar/events.ts`](../src/stellar/events.ts#L369-L378)<br>Tests: `"restarted poller loads recentEventIds from cursor file and does not re-notify"` ([`tests/dedup.test.mjs`](../tests/dedup.test.mjs#L191-L224)); `"Resumes from persisted cursor across poller instances without re-reading old ledgers"` ([`tests/cursor-restart.test.mjs`](../tests/cursor-restart.test.mjs#L12-L67)) |
| **10** | **Graceful shutdown (`SIGTERM`/`SIGINT`) mid-`notify()` burst** | Active HTTP attempt finishes without further retries; remaining unsent events in current batch are aborted (`notificationsDropped`); cursor advances to `scan.lastCursor` and is flushed to disk. | Already-sent events: **not duplicated**.<br>Remaining unsent events in the interrupted batch: **missed (dropped)**. | [`src/poller.ts`](../src/poller.ts#L1666-L1670), [`src/poller.ts`](../src/poller.ts#L2528-L2579)<br>Test: `"shutdown mid-notify finishes active send, drops remaining batch, and flushes cursor"` ([`tests/shutdown.test.mjs`](../tests/shutdown.test.mjs#L77-L127)) |
| **11** | **Abrupt crash (`SIGKILL` / power loss / OOM) mid-cycle after sending $k$ of $N$ events, before `saveCursors("cycle")`** | `CURSOR_FILE` still holds the previous cycle's cursor and `recentEventIds`. On restart, the bot re-scans the current cycle's events. | First $k$ events (sent before crash): **duplicated**.<br>Remaining $N - k$ events: **delivered** on restart. | [`src/poller.ts`](../src/poller.ts#L2192-L2238), [`src/poller.ts`](../src/poller.ts#L2315-L2328)<br>Backed by end-of-cycle `saveCursors("cycle")` placement in `cycle()` `finally` block ([`src/poller.ts`](../src/poller.ts#L2317)). |
| **12** | **Graceful shutdown times out (`> SHUTDOWN_TIMEOUT_MS`) on target 2 (`squad`) after target 1 (`market`) finished** | `market` set `pendingFlush = true`; `poller.shutdown()` runs `saveCursors("shutdown")` on timeout, committing `market`'s cursor and `recentEventIds`. | `market`: **exact (no duplicate)**.<br>`squad`: resumes from prior cursor on restart. | [`src/poller.ts`](../src/poller.ts#L2555-L2572)<br>Test: `"shutdown times out when cycle exceeds timeoutMs and still flushes dirty cursor"` ([`tests/shutdown.test.mjs`](../tests/shutdown.test.mjs#L164-L214)) |
| **13** | **RPC `getHealth` or `getEvents` fails mid-cycle** | Target cursor is not advanced for the failed target (`status.rpcConnected = false`); `exponentialBackoff` schedules next cycle; previously persisted cursor remains intact. | **Delayed** until RPC recovers; **no duplicate and no miss** (unless outage exceeds RPC ledger retention). | [`src/poller.ts`](../src/poller.ts#L2020-L2037), [`src/poller.ts`](../src/poller.ts#L2259-L2305)<br>Test: `"Recovers on next cycle after RPC failure without losing cursor progress"` ([`tests/poller_resilience.test.mjs`](../tests/poller_resilience.test.mjs#L90-L121)) |
| **14** | **Saved cursor contains an invalid/non-numeric paging token (e.g., corrupted cursor token, valid `lastEventLedger`)** | `resumeCursorProblem` rejects the token before calling `getEvents` (`invalid_saved_cursor_reset`); `current.cursor` is cleared to `null` and scan falls back to `startLedger = lastEventLedger`. | **No missed events**; events in `lastEventLedger` are deduplicated by `recentEventIds` (or **duplicated** if not in `recentEventIds`). | [`src/stellar/events.ts`](../src/stellar/events.ts#L168-L185), [`src/poller.ts`](../src/poller.ts#L2067-L2086)<br>Test: `"Clears invalid saved cursor token and falls back to lastEventLedger"` ([`tests/cursor-restart.test.mjs`](../tests/cursor-restart.test.mjs#L69-L115)) |
| **15** | **Extended downtime / slow consumer: saved cursor ledger falls behind RPC `oldestLedger` (retention floor)** | `enforceCursorWindow` (pre-scan) or `rewindFromRetainedFloor` (on RPC stale-cursor error, up to `MAX_FLOOR_REWINDS = 3`) confirms floor via fresh `getHealth()`, clears `cursor`, and rewinds `startLedger` to `oldestLedger` (`restartGaps++`, `gapLedgers +=oldestLedger - cursorLedger`). | Ledgers between `cursorLedger` and `oldestLedger - 1`: **permanently missed**.<br>Ledgers from `oldestLedger` onward: **delivered**. | [`src/poller.ts`](../src/poller.ts#L1868-L1988), [`src/poller.ts`](../src/poller.ts#L2264-L2277)<br>Tests: `"Confirmed stale cursor rewinds to oldestLedger and records gap metrics"` ([`tests/cursor-window.test.mjs`](../tests/cursor-window.test.mjs#L112-L163)); `"Rewinds stale cursor to oldestLedger + 1 and delivers retained events in the same cycle"` ([`tests/cursor-rewind.test.mjs`](../tests/cursor-rewind.test.mjs#L12-L75)) |
| **16** | **Transiently skewed RPC `getHealth()` reports `oldestLedger` ahead of cursor, but fresh `getHealth()` disagrees** | `enforceCursorWindow` re-queries `getHealth()`; when unconfirmed (`freshOldest <= cursorLedger`), it keeps the saved cursor (`stale_cursor_unconfirmed_by_health`). | **Exact (no miss, no rewind)**. | [`src/poller.ts`](../src/poller.ts#L1913-L1942)<br>Test: `"Transiently skewed health snapshot does not discard a valid cursor"` ([`tests/cursor-window.test.mjs`](../tests/cursor-window.test.mjs#L165-L214)) |
| **17** | **`CURSOR_FILE` is missing on startup (first boot or wiped ephemeral container volume)** | Cold start (`seeded = false`): `startLedger = clampStartLedger(latestLedger - START_LOOKBACK_LEDGERS, oldestLedger, latestLedger)` (default `START_LOOKBACK_LEDGERS = 60`). | Events older than `latestLedger - START_LOOKBACK_LEDGERS`: **missed**.<br>Events within lookback window that were announced before volume loss: **duplicated**. | [`src/poller.ts`](../src/poller.ts#L337-L347), [`src/poller.ts`](../src/poller.ts#L1364-L1381), [`src/poller.ts`](../src/poller.ts#L2088-L2110)<br>Test: `"Fresh start with lookback below oldestLedger clamps to oldestLedger"` ([`tests/cursor-window.test.mjs`](../tests/cursor-window.test.mjs#L254-L287)) |
| **18** | **`CURSOR_FILE` is corrupt / truncated JSON on startup** | `loadCursors` renames the bad file to `${CURSOR_FILE}.corrupt.<ISO-timestamp>` (`quarantineCorruptCursorFile`), sets `corruptFallback = true`, and performs a cold start (`latestLedger - START_LOOKBACK_LEDGERS`). | Events older than lookback window: **missed**.<br>Events within lookback window already sent before corruption: **duplicated** (`recentEventIds` lost). | [`src/poller.ts`](../src/poller.ts#L706-L734), [`src/poller.ts`](../src/poller.ts#L1408-L1416)<br>Tests: `"Truncated cursor file is quarantined and poller cold-starts cleanly"`, `"Garbage cursor file is quarantined and subsequent cycle writes clean cursor.json"` ([`tests/cursor-quarantine.test.mjs`](../tests/cursor-quarantine.test.mjs#L12-L97)) |
| **19** | **`CURSOR_FILE` disk write fails (`EACCES` / `ENOSPC` / unwritable path)** | In-memory `cursor` and `dedupWindow` still advance (`pendingFlush = true`, `saveErrors++`), preventing duplicates while the process stays alive. If the process restarts before disk recovery, in-memory progress since the last successful write is lost. | While process remains running: **exact (no duplicate)**.<br>After restart if disk never recovered: **duplicates** (or **misses** if cold-started). | [`src/poller.ts`](../src/poller.ts#L1452-L1468)<br>Test: `"Advances in-memory cursor when cursorFile path is unwritable"` ([`tests/cursor-restart.test.mjs`](../tests/cursor-restart.test.mjs#L156-L200)) |
| **20** | **Single-cycle burst exceeds `MAX_NOTIFICATIONS_PER_CYCLE` (default `20`)** | First `20` notifications for the target are sent; remaining events in that target's scan batch are skipped (`eventsSkipped++`, `notification_cap_reached`); cursor still advances to `scan.lastCursor`. | First `MAX_NOTIFICATIONS_PER_CYCLE` events: **delivered**.<br>Overflow events in the same scan batch: **missed (dropped)**. | [`src/poller.ts`](../src/poller.ts#L1725-L1760), [`src/poller.ts`](../src/poller.ts#L2214-L2233)<br>Test: `"Caps notifications per cycle and skips overflow without failing"` ([`tests/poller_resilience.test.mjs`](../tests/poller_resilience.test.mjs#L222-L260)) |
| **21** | **Contract backlog spans more than `EVENT_MAX_PAGES` (`20` pages $\times$ `200` events = `4,000` raw events)** | `paginatedGetEvents` stops at 20 pages (`truncated = true`), returns `lastCursor` of page 20, notifies up to `MAX_NOTIFICATIONS_PER_CYCLE` for that slice, saves page 20's cursor, and continues from page 21 on the next poll cycle. | Events beyond page 20 are **delayed** to subsequent cycles (subject to per-cycle `MAX_NOTIFICATIONS_PER_CYCLE` cap on each cycle). | [`src/stellar/events.ts`](../src/stellar/events.ts#L45-L51), [`src/stellar/events.ts`](../src/stellar/events.ts#L275-L278), [`src/poller.ts`](../src/poller.ts#L2180-L2189)<br>Test: `"Walks multi-page event streams and resumes from the final cursor"` ([`tests/cursor-restart.test.mjs`](../tests/cursor-restart.test.mjs#L117-L154)) |
| **22** | **Second bot instance started against the same `CURSOR_FILE`** | `acquireInstanceLock` checks `${CURSOR_FILE}.lock`. If locking PID is alive (`isProcessAlive`), startup throws `InstanceLockError` before reading or writing `CURSOR_FILE`. If locking PID died (`SIGKILL`), stale lock is stolen cleanly. | **Prevented (no concurrent double-delivery)**; stale lock after `SIGKILL` recovers automatically. | [`src/instanceLock.ts`](../src/instanceLock.ts#L103-L169), [`src/poller.ts`](../src/poller.ts#L2415-L2429)<br>Tests: `"blocks a second instance while the first holds the lock"`, `"steals a stale lock left behind by a dead PID"`, `"poller refuses to start when another instance holds the cursor lock"` ([`tests/instance-lock.test.mjs`](../tests/instance-lock.test.mjs#L33-L113)) |

---

## 7. Evidence Index

### Source Modules
- [`src/stellar/decode.ts`](../src/stellar/decode.ts) — `extractOrderField`, `compareEvents`, `sortEvents`, `dedupeEvents`, `decodeEvent`
- [`src/stellar/events.ts`](../src/stellar/events.ts) — `paginatedGetEvents`, `readContractEvents`, `eventCursorLedger`, `resumeCursorProblem`, `EVENT_PAGE_LIMIT`, `EVENT_MAX_PAGES`
- [`src/dedup.ts`](../src/dedup.ts) — `eventKey`, `topicDigest`, `EventDedupWindow`, `DEFAULT_DEDUP_WINDOW`, `MAX_KEY_CHARS`
- [`src/poller.ts`](../src/poller.ts) — `createPoller`, `cycle`, `notify`, `sendWithRetry`, `flushDeadLetter`, `loadCursors`, `saveCursors`, `quarantineCorruptCursorFile`, `enforceCursorWindow`, `rewindFromRetainedFloor`, `shutdown`
- [`src/deadLetter.ts`](../src/deadLetter.ts) — `createDeadLetterQueue`, `makeEntryId`, `DEAD_LETTER_MAX_ENTRIES`, `DEAD_LETTER_MAX_ATTEMPTS`
- [`src/instanceLock.ts`](../src/instanceLock.ts) — `acquireInstanceLock`, `InstanceLockError`, `isProcessAlive`
- [`src/index.ts`](../src/index.ts) — `SIGINT` / `SIGTERM` graceful shutdown and force-exit handlers

### Verification Test Suites
- [`tests/ordering.test.mjs`](../tests/ordering.test.mjs) — Deterministic comparator (`ledger`, `transactionIndex`, `operationIndex`, `eventId`, `txHash`, stability, TOID parsing)
- [`tests/dedup.test.mjs`](../tests/dedup.test.mjs) — `eventKey` derivation hierarchy, `EventDedupWindow` FIFO eviction, capacity `0`, oversized keys, and `recentEventIds` persistence across restarts
- [`tests/page-dedup.test.mjs`](../tests/page-dedup.test.mjs) — Cross-page and cross-cycle deduplication in `readContractEvents` / `paginatedGetEvents`
- [`tests/deadLetter.test.mjs`](../tests/deadLetter.test.mjs) — DLQ persistence, deterministic entry deduplication, `maxEntries` FIFO eviction, `maxAttempts` poison drop, corrupt file quarantine
- [`tests/poller-dlq.test.mjs`](../tests/poller-dlq.test.mjs) — End-to-end poller DLQ enqueue on failed send, next-cycle replay, and `maxAttempts` drop
- [`tests/poller_resilience.test.mjs`](../tests/poller_resilience.test.mjs) — RPC failure recovery, `sendWithRetry` transient retries, HTTP 429 `Retry-After`, partial delivery cursor advance, and `MAX_NOTIFICATIONS_PER_CYCLE` cap
- [`tests/cursor-restart.test.mjs`](../tests/cursor-restart.test.mjs) — Cursor persistence across restarts, invalid cursor token fallback, multi-page stream walking, and unwritable `cursorFile` handling
- [`tests/cursor-window.test.mjs`](../tests/cursor-window.test.mjs) — Pre-scan cursor retention window classification, stale cursor rewind confirmation, and cold-start lookback clamping
- [`tests/cursor-rewind.test.mjs`](../tests/cursor-rewind.test.mjs) — RPC stale-cursor error detection and automatic rewind to `oldestLedger`
- [`tests/cursor-quarantine.test.mjs`](../tests/cursor-quarantine.test.mjs) — Corrupt/truncated `cursor.json` quarantine and cold-start recovery
- [`tests/cursor-backup.test.mjs`](../tests/cursor-backup.test.mjs) — Atomic `.tmp` write-then-rename and `.bak` backup preservation
- [`tests/shutdown.test.mjs`](../tests/shutdown.test.mjs) — Graceful shutdown mid-RPC read, mid-`notify()` batch abort, and shutdown timeout dirty-cursor flush
- [`tests/instance-lock.test.mjs`](../tests/instance-lock.test.mjs) — Single-instance lock enforcement and dead-PID stale lock recovery
