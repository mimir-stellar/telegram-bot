# Replaying Ledgers & Recovering Missed Events

Operational procedure for replaying a ledger range after a process interruption, network outage, or bot downtime.

---

## Operating Principles

- **Chain is Source of Truth:** On-chain events on Stellar/Soroban remain permanent. The replay CLI reads directly from RPC `getEvents`.
- **Replay CLI is Read-Only with Respect to Cursors:** Running `npm run replay` never writes to `data/cursor.json` and never modifies live poller state.
- **Dry-Run by Default:** Without `--send`, the CLI performs a dry run that logs, decodes, and summarizes events without contacting Telegram or requiring bot credentials.
- **Idempotency & Caps:** Replay respects notification caps (`--cap`) and event deduplication windows to prevent message flooding.

---

## Quick Rehearsal: Mock Mode

Before operating against live networks, rehearse the replay workflow locally using the built-in mock profile:

```bash
# Replay against local mock RPC without network calls or credentials
npm run replay:mock -- --from 100 --to 110

# Output machine-readable JSON summary in mock mode
npm run replay:mock -- --from 100 --to 110 --json
```

> **Tip:** When testing with mock mode standalone, start the mock RPC server first in a separate terminal via `npm run mock:rpc` (listens on `http://127.0.0.1:8420`).


---

## Step-by-Step Recovery Procedure

### Step 1: Identify the Missed Ledger Range

When recovering after an outage, identify the range of missed ledgers using:

1. **Bot `/health` or `/status` endpoint / command:**
   Inspect the reported cursor ledger and the chain tip:
   - `lastEventLedger` or `cursor`: The last processed position before downtime.
   - `latestLedger`: The current chain tip reported by RPC `getHealth`.
   - `oldestLedger`: The oldest ledger retained in the RPC rolling window.
2. **Service logs:**
   Search for the last logged poll or event sequence:
   ```text
   [poller] poll complete ... lastLedger=4226500
   ```
   In this scenario, set `--from 4226501` to resume scanning immediately after the last processed ledger.

### Step 2: Dry-Run Replay

Always run a dry run first to inspect the events in the target range:

```bash
# Replay from a specific ledger up to the current chain tip
npm run replay -- --from 4226500

# Replay an explicit range [from, to]
npm run replay -- --from 4226500 --to 4226800

# Focus on a single contract target (market or squad)
npm run replay -- --from 4226500 --to 4226800 --contract market

# Print decoded event details during execution
npm run replay -- --from 4226500 --to 4226800 --show 10
```

Review the dry-run summary:
```text
[replay] done  events=8 sent=0 skipped=0 capped=0 admin=0 duplicates=0
```
Verify that the event count matches expectations and no unhandled decoding errors occurred.

### Step 3: Live Send Replay

Once the dry run is verified, deliver notifications to Telegram by adding `--send`:

```bash
npm run replay -- --from 4226500 --to 4226800 --send
```

> **Requirements for `--send`:**
> `BOT_TOKEN` and `TELEGRAM_CHAT_ID` must be configured in environment variables or `.env`.

If replaying a large range, protect RPC limits and bot rate limits:
- Use `--rpc-budget <N>` to throttle RPC requests per minute.
- Use `--cap <N>` to bound the maximum notifications sent per contract.
- Use `--progress <file>` to checkpoint progress to disk:
  ```bash
  npm run replay -- --from 4226500 --to 4226800 --send --progress .replay-progress.json
  ```
  If interrupted, re-running with the same arguments and `--progress` file resumes where it left off.

### Step 4: Verify Delivery

Check the Telegram chat to verify:
1. Messages were delivered with correct formatting and MarkdownV2 escaping.
2. Admin events were logged, not delivered (enforced by replay safety guards).
3. Check the exit code:
   - `0`: Scan completed successfully.
   - `1`: Fatal runtime error (RPC failure or invalid config).
   - `2`: CLI usage error (invalid flags or inverted range).

### Step 5: Check and Confirm Poller Cursor

Because `npm run replay` is strictly read-only regarding cursor state, the live poller's cursor (`data/cursor.json`) is not automatically bumped by replay.

1. Inspect current cursor state:
   ```bash
   npm run cursor
   ```
2. If restarting the live poller, verify whether the poller should catch up from its stored cursor or if the cursor needs manual seeding to the end of the replayed range:
   ```bash
   # Seed cursor to the replayed ledger if needed
   npm run seed:cursor -- --ledger 4226800
   ```

---

## RPC Retention Limits & Unavailable Ranges

### How RPC Retention Works

Soroban RPC servers maintain a rolling window of history:
- `oldestLedger`: The oldest ledger still available in the RPC.
- `latestLedger`: The current chain tip.

The replay CLI queries `getHealth()` on startup and validates the requested range against this window via `validateLedgerWindow`:
- If `--from` is **below `oldestLedger`**:
  The CLI logs a warning and clamps the start ledger up to `oldestLedger` (`clampStartLedger`), because earlier ledgers have already been pruned by the RPC node.
- If `--from` is **ahead of `latestLedger`**:
  The CLI aborts with exit code 2 (`start-after-tip`).

### What to Do When the Range is Pruned

If the service was down longer than the RPC retention window (e.g. Several days on testnet or heavily pruned private RPCs):

1. **Check Gap Size:**
   Compare the missed ledger range `[missedStart, missedEnd]` with the RPC's `oldestLedger`.
2. **Replay Available Window:**
   Run replay from `oldestLedger` onwards to recover all available events:
   ```bash
   npm run replay -- --from <oldestLedger> --send
   ```
3. **Historical / Archived Data:**
   For events prior to `oldestLedger`:
   - Point `STELLAR_RPC_URL` temporarily to an archive or full-history RPC provider.
   - Or extract historical transaction results via Horizon or Hubble data lake exports.
4. **Resume Live Poller:**
   Seed the poller cursor to `oldestLedger` or the latest replayed ledger to ensure continuous monitoring.

---

## Replay CLI Reference

All flags supported by `src/replay-cli.ts` / `src/stellar/replay.ts`:

| Flag | Argument | Description | Default |
| :--- | :--- | :--- | :--- |
| `--from` | `<ledger\|cursor>` | **Required.** Starting ledger sequence number or event cursor. | *None* |
| `--to` | `<ledger>` | Ending ledger sequence number. | Chain tip |
| `--send` | *None* | Deliver notifications to Telegram (requires bot config). | Off (dry-run) |
| `--dry-run` | *None* | Scan and decode without posting to Telegram. | On |
| `--contract` | `market` \| `squad` | Limit scan to a specific contract target. | Both |
| `--pages` | `<N>` | Maximum RPC event pages to fetch per contract. | `50` |
| `--cap` | `<N>` | Maximum notifications sent per contract cycle. | `25` |
| `--show` | `<N>` | Number of decoded events to print to stderr. | `0` |
| `--json` | *None* | Output machine-readable `mimir-replay-v1` JSON to stdout. | Off |
| `--mock` | *None* | Use local mock RPC profile (`MIMIR_PROFILE=mock`). | Off |
| `--progress` | `<path>` | Path to persist and resume progress (`mimir-replay-progress-v1`). | None |
| `--rpc-budget` | `<N>` | Maximum RPC requests per minute. | Unlimited |

### Exit Codes

- `0`: Scan and replay completed successfully.
- `1`: Fatal runtime error (network error, RPC failure, or missing bot credentials in `--send` mode).
- `2`: Usage error (missing `--from`, invalid number format, or `--to` before `--from`).
