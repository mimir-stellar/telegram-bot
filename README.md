# Mimir Telegram bot

A Telegram notifier for [Mimir](https://github.com/mimir-stellar), the AI-settled
prediction market on Stellar. It polls Mimir's two Soroban contracts for new
on-chain events and posts them, human-readable, into a chat or channel:

```
🆕 New claim #7
Category: crypto
Creator: GBMGZ…IR2Y
ledger 4226691 · tx

⚔️ Claim #7 challenged
Stake: 2.0000000 USDC
Challenger: GDZCB…X4UH
ledger 4226692 · tx

⚖️ Claim #7 resolved — winner: challengers
Confidence: 100%
Onchain smoke — challengers awarded so the payout pull can be exercised
ledger 4226728 · tx
```

Built with [grammy](https://grammy.dev) and
[`@stellar/stellar-sdk`](https://github.com/stellar/js-stellar-sdk). Reads only —
it holds no keys and signs nothing.

## What it watches

| Contract | Events it notifies on |
|---|---|
| `mimir-market` | `claim_created`, `claim_challenged`, `claim_resolved`, `claim_cancelled`, `market_settled`, `challenger_paid`, `fee_claimed`, `withdrawal`, `withdrawal_pending` |
| `mimir-squad` | `market_created`, `deposited`, `withdrawn`, `resolved`, `claimed`, `fees_claimed` |

Admin events (`oracle_changed`, `ownership_transferred`, `fee_policy_*`,
`fee_accrued`, `agent_attributed`) are decoded far enough to be recognised and
then skipped — they are logged, not posted.

## Setup

### 1. Get a bot token

Message [@BotFather](https://t.me/BotFather) on Telegram, send `/newbot`, follow
the prompts, and copy the token it gives you (`123456789:AA…`).

### 2. Get the chat id

- **Private chat:** message [@userinfobot](https://t.me/userinfobot); it replies
  with your numeric id.
- **Group:** add your bot to the group, send any message, then open
  `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` and read
  `result[].message.chat.id`. Group and supergroup ids are negative
  (`-1001234567890`).
- **Channel:** add the bot as an administrator with "Post messages" permission.
  Either use the numeric id from `getUpdates` or, for a public channel, the
  `@channelusername`.

If your group has [privacy mode](https://core.telegram.org/bots/features#privacy-mode)
on (the default), the bot only sees messages that are commands or replies to it —
which is all `/status` needs.

### 3. Configure and run

```bash
cp .env.example .env     # then fill in BOT_TOKEN and TELEGRAM_CHAT_ID
npm install
npm run dev              # tsx, restarts on change
```

For production:

```bash
npm run build
npm start
```

`.env.example` ships with the live Stellar Testnet contract ids, so the only two
values you must supply are `BOT_TOKEN` and `TELEGRAM_CHAT_ID`. Every other
variable is documented inline there. A missing or malformed value aborts startup
with all the problems listed at once — the bot never boots into a state where it
looks healthy but notifies nobody.

## Commands

| Command | What it does |
|---|---|
| `/start` | What the bot is |
| `/help` | Same, plus the command list |
| `/status` | Chain tip, the RPC's retained-history floor, both watched contract ids, the last ledger an event was seen in per contract, the persisted cursor, poll/send counters and the last error |
| `/audit` | The operator audit report: recent scan failures, send failures, skipped and cap-dropped events, cursor problems — redacted and bounded (see [Operator audit trail](#operator-audit-trail)) |

## Reading events without a bot token

The chain reader runs standalone. Testnet's Soroban RPC is public and
unauthenticated, so this needs nothing but the contract ids:

```bash
npm run scan                     # both contracts, from the RPC's retained floor
npm run scan -- --pages 40       # walk further
npm run scan -- --show 20        # print 20 decoded events per contract
npm run scan -- --from 4226500   # explicit start ledger
```

It prints the ledger window, an event-name histogram, and the decoded payloads.
This is how the decoder was verified against the live deployment.

## Operator audit trail

`/status` says what the poller is doing *right now*. The audit trail answers the
question after a week of unattended running: **what actually happened** — scan
failures and recoveries, failed Telegram sends, skipped admin events, bursts
truncated by the per-cycle cap, cursor loads, stale cursors and cursor write
failures.

It is an append-only JSONL file (`data/audit.jsonl` by default; `AUDIT_FILE`
changes it, leaving the value empty disables it). The poller appends after every
cycle, so the trail survives restarts alongside the cursor. Read it two ways:

```bash
npm run audit                  # report from data/audit.jsonl
npm run audit -- --tail 50     # render the 50 most recent lines
npm run audit -- --json        # machine-readable stats only
npm run audit -- --file p.jsonl
```

or send `/audit` in the chat, which merges the live in-memory window with the
file so entries not yet flushed are still visible.

Everything in the trail is safe to paste into an issue, and this is enforced
when an entry is recorded, not by caller discipline:

- Free-text details pass redaction first: bot tokens, secret/seed strkeys, URLs
  and any unrecognized long token are replaced. Public `C…` contract ids and
  `G…` account ids stay readable — they are chain identifiers `/status` already
  prints.
- Details are length-clamped (240 chars). No payloads, payment amounts as log
  lines, or unbounded remote data are ever stored — the chain is the record.
- The in-memory window and the report are both bounded, and the report says so
  when older entries were not shown.
- Reading never throws on you: an unreadable or unknown-version line is skipped
  and counted, never fatal.

## How the polling works

Soroban's `getEvents` is **not** `eth_getLogs`, and the difference is the whole
design of `src/stellar/events.ts`:

- Paging is by **opaque cursor**, not block range, so the walk is inherently
  sequential — there is no chunk fan-out to parallelise.
- `startLedger`/`endLedger` and `cursor` are **mutually exclusive** in one
  request.
- The RPC keeps only a **rolling window** of events (~120,960 ledgers, roughly a
  week, on Testnet). A `startLedger` below the retained floor is an *error*, not
  an empty result, so the floor is clamped from `getHealth()` first.
- **An empty page does not mean the scan is finished.** One request covers a
  bounded slice of ledgers and returns whatever was in it — frequently nothing —
  plus a cursor to continue from. Terminating on a short page (the correct
  instinct for `eth_getLogs`) silently yields zero events. Verified against the
  live deployment: reading the market contract from the retained floor takes 13
  pages, 12 of which are empty, to reach the page holding all 11 of its events.

So the walk terminates on the cursor, never on the payload.

Events are also not a source of truth for current state — a claim's stakes and
status come from the contract's own getters. This bot is a timeline, not an
index.

## Cursor persistence

The poller writes its resume position to `data/cursor.json` (write-then-rename,
so a crash mid-write cannot truncate it) and appends audit entries to
`data/audit.jsonl`. Both must survive restarts, so give `data/` the same
treatment as the cursor:

```json
{
  "version": 1,
  "updatedAt": "2026-08-21T10:00:00.000Z",
  "targets": {
    "market": { "cursor": "0018276211125911551-4294967295", "lastEventLedger": 4226729 },
    "squad":  { "cursor": "0018276211125911551-4294967295", "lastEventLedger": 4226733 }
  }
}
```

On a cold start (no file) it begins `START_LOOKBACK_LEDGERS` behind the chain tip
rather than replaying the whole retained window into your chat.

**Deployment note:** a flat file is fine for v0 but it must survive restarts. On
an always-on host, put `data/` on a persistent volume (or point `CURSOR_FILE`
at one). On an ephemeral filesystem every restart is a cold start, and events
that happened while the bot was down are never posted. Swapping this for a real
KV store is a deliberate future step, not something this repo does today.

## Failure behaviour

This process is meant to stay up for weeks, so a single failure never ends it:

- **A failed RPC call** fails one contract's scan for one cycle. Its cursor is
  left untouched, so the next cycle resumes exactly where it stopped.
- **A failed Telegram send** drops one message; the cursor still advances. That
  is deliberate: holding the cursor back would turn a revoked token or a chat
  the bot was removed from into an infinite replay, and recovery would flood the
  channel. Notifications are lossy on purpose — the chain is the record.
- **A corrupt cursor file** is treated as a cold start rather than a crash.
- **A burst** is capped at `MAX_NOTIFICATIONS_PER_CYCLE` messages per cycle,
  spaced out, so Telegram's rate limiter is never the thing that takes the bot
  down.
- **An unreadable audit line** (or a failed append) is logged and skipped; the
  audit trail never throws into the poll loop, and a bad line never takes the
  report down. An audit file that cannot be read at all reports as empty.

## Layout

```
src/
  index.ts                 entry point: config -> RPC -> bot -> poller
  config.ts                env loading and validation, fails fast
  bot.ts                   grammy setup: /start, /help, /status, /audit
  poller.ts                the loop: scan, notify, persist the cursor, flush audit
  audit.ts                 redaction, bounded audit log, JSONL persistence, report renderer
  audit-cli.ts             entrypoint for `npm run audit`
  stellar/
    client.ts              Soroban RPC client + explorer links
    events.ts              cursor-paginated getEvents (+ the standalone CLI)
    decode.ts              typed decoding of both contracts' events
  notifications/
    format.ts              decoded event -> MarkdownV2 message
tests/
  format.test.mjs          notification formatting (incl. deterministic fuzz)
  audit.test.mjs           redaction, entries, persistence, report rendering
```

## Development checks

Run `npm run typecheck` for a no-emit TypeScript check, `npm test` for the build plus the notification-format and audit-trail tests (including deterministic fuzz cases), or `npm run build` to produce the production output. No test or check requires live Testnet access or Telegram credentials.

## License

[AGPL-3.0-or-later](./LICENSE), matching the rest of Mimir.
