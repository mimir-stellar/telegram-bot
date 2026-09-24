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
which covers `/status` and the operator controls below.

### 3. Choose an operator (optional)

Set `OPERATOR_TELEGRAM_USER_ID` to the numeric **user** id returned by
`@userinfobot` to enable `/pause` and `/resume`. The notification
`TELEGRAM_CHAT_ID` is intentionally not accepted as authorization: in a group,
everyone can send messages from that chat. If this variable is omitted, existing
deployments continue unchanged and both operator commands are ignored.

### 4. Configure and run

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
| `/contracts` | The two contract ids this bot watches (`mimir-market`, `mimir-squad`) and a [stellar.expert](https://stellar.expert) link for each. Reads only from config, so it answers the same during a cold start, a run of RPC failures, or between restarts — unlike `/status`, there is nothing here that can be "unhealthy" |
| `/pause` | Operator only. Stops scheduling new poll cycles; a scan already in progress may finish and persist its normal cursor |
| `/resume` | Operator only. Schedules the next poll cycle immediately, without changing or replaying cursors |

Commands from a user other than `OPERATOR_TELEGRAM_USER_ID` receive no control
response and cannot mutate poller state. Repeated `/pause` or `/resume` commands
are idempotent. Control state is process-local: a restart resumes polling and
loads the existing version-1 cursor file.

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
so a crash mid-write cannot truncate it):

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
rather than replaying the whole retained window into your chat. `/pause` and
`/resume` never edit this file; they only control scheduling, so the cursor
format remains version 1 and a restart does not preserve a pause.

**Deployment note:** a flat file is fine for v0 but it must survive restarts. On
an always-on host, put `data/` on a persistent volume (or point `CURSOR_FILE`
at one). On an ephemeral filesystem every restart is a cold start, and events
that happened while the bot was down are never posted. Swapping this for a real
KV store is a deliberate future step, not something this repo does today.

## Failure behaviour

This process is meant to stay up for weeks, so a single failure never ends it:

- **A failed RPC call** fails one contract's scan for one cycle. Its cursor is
  left untouched, so the next cycle resumes exactly where it stopped.
- **A failed Telegram send** receives at most three attempts with bounded
  exponential backoff, then drops one message; the cursor still advances. That
  is deliberate: holding the cursor back would turn a revoked token or a chat
  the bot was removed from into an infinite replay, and recovery would flood the
  channel. Notifications are lossy on purpose — the chain is the record. Operator
  `/resume` does not replay failed messages.
- **A corrupt cursor file** is treated as a cold start rather than a crash. A
  valid but RPC-rejected stale cursor is never silently rewound: the target keeps
  that cursor, the error becomes visible in `/status`, and scheduled retries or
  `/resume` use the same position. Recovery follows the incident runbook rather
  than replacing an opaque cursor with a guessed ledger.
- **A burst** is capped at `MAX_NOTIFICATIONS_PER_CYCLE` messages per cycle,
  spaced out, so Telegram's rate limiter is never the thing that takes the bot
  down. RPC, Telegram, and poller error text shown in `/status` or logs is
  compact, bounded, and the configured bot token is redacted.
- **An operator pause** prevents new cycles but cannot cancel a bounded scan or
  Telegram retry loop already in progress. That cycle follows the normal cursor
  rules above; `/resume` starts the next cycle immediately.

## Health endpoint

The process exposes a **loopback HTTP** probe for supervisors and deploy
checks (default `http://127.0.0.1:8787`):

| Path | Meaning |
| --- | --- |
| `GET /health` (alias `/healthz`) | Readiness-style status. `200` when the poller is running and healthy, including an intentional operator pause; `503` when stopped or degraded (repeated RPC failures or a stale success window). The response includes `poller.paused`. |
| `GET /health/live` (alias `/livez`) | Liveness only — the process and HTTP server are up. Always `200` while listening. |

The JSON body is operational status only: poller counters, ledgers, truncated
cursors, and whether a target has an error. It never includes `BOT_TOKEN`,
chat ids, private keys, or unbounded remote payloads.

Configuration (see `.env.example`):

- `HEALTH_HOST` — bind address (default `127.0.0.1`)
- `HEALTH_PORT` — TCP port (default `8787`; `0` disables)
- `HEALTH_STALE_MS` — degraded if no successful poll within this window after the first success (default `90000`; `0` disables)

**Rollback:** set `HEALTH_PORT=0` (or omit the new env keys to keep defaults) and
redeploy the previous image — the health module is additive and does not change
cursor format or Telegram behaviour.

**Failure modes:** binding fails only if the port is already taken (process
exits via the listen error path after logging). Client disconnects and probe
errors are logged and ignored so they cannot stop the notifier.

## Layout

```
src/
  index.ts                 entry point: config -> RPC -> bot -> poller -> health HTTP
  health.ts                local loopback GET /health for supervisors
  config.ts                env loading and validation, fails fast
  bot.ts                   grammy setup: /start, /help, /status, /contracts, operator pause/resume
  poller.ts                the loop: scan, notify, persist the cursor
  stellar/
    client.ts              Soroban RPC client + explorer links (tx + contract)
    events.ts              cursor-paginated getEvents (+ the standalone CLI)
    decode.ts              typed decoding of both contracts' events
  notifications/
    format.ts              decoded event -> MarkdownV2 message
```

## Development checks

Run `npm run typecheck` for a no-emit TypeScript check, `npm test` for the build plus the deterministic command, poller, format, fixture and health suites, or `npm run build` to produce the production output. CI runs typecheck, build, and all tests without network credentials.

Contributor workflow for credential-free fixtures (event catalogs, cursor samples, failure-mode expectations) lives in [docs/contributor-fixtures.md](docs/contributor-fixtures.md). Automated tests never require live Testnet RPC access, Telegram credentials, or signing keys.

## License

[AGPL-3.0-or-later](./LICENSE), matching the rest of Mimir.
