# Contributor fixture guide

This guide explains how to add **credential-free fixtures** for the Mimir
Telegram notifier. Automated tests must stay deterministic: no Soroban RPC
calls, no Telegram API calls, no bot tokens, and no signing keys.

The chain is the source of truth. This bot is a read-only notifier — fixtures
model decoded events and cursor files, never private material.

## Quick start (clean checkout)

```bash
npm ci
npm run typecheck
npm test
```

`npm test` builds `src/` → `dist/`, then runs every `tests/*.test.mjs` file with
Node's built-in test runner (the same path CI uses).

Live Testnet scanning is **manual and separate**:

```bash
npm run scan -- --pages 5 --show 5
```

Do not wire `npm run scan` into automated tests.

## Where fixtures live

| Path | Purpose |
| --- | --- |
| `tests/fixtures/events.json` | Decoded event cases for `formatEvent` / notifier fakes |
| `tests/fixtures/cursor-valid.json` | Well-formed `data/cursor.json` shape for restart docs |
| `tests/fixtures/cursor-corrupt.txt` | Unreadable cursor sample (cold-start path) |
| `tests/fixtures.test.mjs` | Loads the fixture catalog and asserts notify / skip / boundary / restart behaviour |
| `tests/format.test.mjs` | Inline unit cases (MarkdownV2 escape, USDC decimals, send failures, version stamp) |

## Event fixture schema

`events.json` is a catalog:

```json
{
  "config": {
    "chatId": "-1001234567890",
    "marketContractId": "CFIXTUREMARKET00000000000000000000000000000000000000000",
    "squadContractId": "CFIXTURESQUAD0000000000000000000000000000000000000000000",
    "rpcUrl": "https://example.invalid/rpc",
    "horizonUrl": "https://example.invalid/horizon",
    "networkPassphrase": "Test SDF Network ; September 2015"
  },
  "cases": [
    {
      "id": "claim_challenged_happy",
      "kind": "positive",
      "expect": "notify",
      "messageIncludes": ["challenged", "2\\.0000000 USDC"],
      "event": { "...": "DecodedEvent shape; money fields are decimal strings" }
    }
  ]
}
```

Rules:

1. **Money fields are decimal strings** (`"20000000"`), never live JSON numbers
   for large `i128` values. The fixture loader converts known money keys to
   `bigint` before calling `formatEvent`.
2. **Contract ids, addresses, tx hashes, and cursors are stable fakes.** Prefer
   `CFIXTURE…` / `GFIXTURE…` prefixes so grepping the suite never looks like
   production secrets.
3. **RPC / Horizon URLs must be non-routable** (`example.invalid`) so a buggy
   test cannot accidentally hit Testnet.
4. **Never put `BOT_TOKEN`, payment proofs, or private keys in fixtures or
   assertions.** Logs and error messages under test must stay free of those.

### Case kinds (what to cover)

| `kind` | Intent | Typical `expect` |
| --- | --- | --- |
| `positive` | Happy-path notification for a known market/squad event | `notify` |
| `negative` | Malformed / unknown / admin-shaped payload → no chat message | `skip` |
| `boundary` | Clipping, reserved MarkdownV2 chars, zero/max amounts | `notify` or `skip` |
| `restart` | Events arriving after a process restart / cold start from cursor resume | `notify` or `skip` |

`expect: "notify"` requires a non-null MarkdownV2 string from `formatEvent`.
`expect: "skip"` requires `null` (or an `unknown` payload that the poller would
log and not post).

`restart` cases have a `note` field explaining the post-restart scenario. They
are not structural — `formatEvent` behaviour is identical regardless of restart
state. The fixture documents that version metadata changes (or any other
wiring change) must not alter the notify/skip outcome.

## Cursor fixtures and restart safety

- **Valid cursor** (`cursor-valid.json`): version `1`, per-target opaque
  `cursor` string + `lastEventLedger`. Matches what the poller write-then-renames
  under `CURSOR_FILE` (default `./data/cursor.json`).
- **Corrupt cursor** (`cursor-corrupt.txt`): not JSON. The poller must treat this
  as a **cold start**, not a crash — leave the in-memory cursor null and begin
  `START_LOOKBACK_LEDGERS` behind tip.

When you add persistence tests:

- Point `CURSOR_FILE` at a path under `os.tmpdir()`.
- Always unlink the temp file in `finally`, including after failed assertions.
- Never commit a real runtime `data/cursor.json` from a live bot.

## Failure-mode expectations (keep fixtures aligned)

| Failure | Cursor | Notification | Fixture tip |
| --- | --- | --- | --- |
| RPC error for one contract | **unchanged** for that target | none that cycle | Fake rejected `readContractEvents`; assert cursor string identical |
| Telegram send error | **still advances** | counted as failed | Fake `sendMessage` reject; assert no token in the Error message |
| Corrupt cursor file | cold start | n/a | Use `cursor-corrupt.txt` contents |
| Burst over cap | advances | extras skipped | Cap `MAX_NOTIFICATIONS_PER_CYCLE` in the fake config |

## Adding a new fixture case

1. Pick the contract event from `src/stellar/decode.ts` (topic order + value map).
2. Append a case to `tests/fixtures/events.json` with a unique `id`.
3. Run `npm test` and extend assertions in `tests/fixtures.test.mjs` only if the
   catalog runner needs a new expect mode.
4. If behaviour changes ops (env vars, cursor shape), update this guide and the
   README "Development checks" link in the same PR.

## Version metadata

The package version (`package.json` `"version"`) is stamped at four surfaces:

| Surface | Format | Source |
| --- | --- | --- |
| Boot log | `[boot] Mimir Telegram notifier v0.1.0` | `src/index.ts` via `loadVersion()` |
| `/status` reply | `Status — running on Stellar testnet · v0.1.0` | `src/bot.ts` |
| `/version` reply | `Mimir Telegram notifier v0.1.0` | `src/bot.ts` |
| `GET /health` JSON | `{ "version": "0.1.0", … }` | `src/health.ts` / `buildHealthReport` |
| `npm run scan` banner | `Mimir scan  v0.1.0` | `src/stellar/events.ts` |

`loadVersion()` in `src/config.ts` reads `package.json` at runtime via a
path relative to `import.meta.url`. This resolves correctly from both `src/`
(dev with `tsx`) and `dist/` (production build). It returns `"unknown"` if the
file is missing or unparseable — that must not happen in CI.

### Tests that cover version

- `tests/fixtures.test.mjs` — `loadVersion returns a semver-shaped string`
  asserts the build resolves a `MAJOR.MINOR.PATCH` string, not `"unknown"`.
- `tests/health.test.mjs` — three unit tests assert `buildHealthReport` emits
  the supplied version, defaults to `"unknown"` when omitted, and never leaks
  the bot token via the version field.
- `tests/format.test.mjs` — `/status reply includes version stamp` dispatches a
  fake `/status` command through `bot.handleUpdate` and checks the version
  appears in the MarkdownV2 reply without leaking the bot token.

### Version safety rules

- The version comes from `package.json` only — never from env vars or user input.
- `GET /health` includes `version` but never `botToken`, `chatId`, or any
  credential. The health serialiser does not write those fields.
- Bumping `package.json` `"version"` is the only step needed to update all
  surfaces in a release.

## Version metadata

The package version (`package.json` `"version"`) is stamped in three places at
runtime:

| Surface | Format | Added by |
| --- | --- | --- |
| Boot log | `[boot] Mimir Telegram notifier v0.1.0` | `src/index.ts` via `loadVersion()` |
| `/status` reply | `Status — running on Stellar testnet · v0.1.0` | `src/bot.ts` |
| `/version` reply | `Mimir Telegram notifier v0.1.0` | `src/bot.ts` |
| `GET /health` JSON | `{ "version": "0.1.0", … }` | `src/health.ts` via `buildHealthReport` |
| `npm run scan` banner | `Mimir scan  v0.1.0` | `src/stellar/events.ts` |

`loadVersion()` in `src/config.ts` reads the version once from `package.json`
at runtime. It resolves the path relative to `import.meta.url`, so it works
from both `src/` (dev) and `dist/` (production build). It falls back to
`"unknown"` if the file is missing or unparseable — this must never happen in
CI.

### Tests that cover version metadata

- `tests/fixtures.test.mjs` — `loadVersion returns a semver-shaped string from package.json`
  asserts that the running build resolves a `MAJOR.MINOR.PATCH` version, not
  the fallback `"unknown"`.
- `tests/health.test.mjs` — three unit tests assert that `buildHealthReport`
  includes the supplied version, defaults to `"unknown"`, and never leaks the
  bot token through the version field.
- `tests/format.test.mjs` — `/status reply includes version stamp` dispatches a
  fake `/status` command through `bot.handleUpdate` and asserts the version
  string appears in the reply without leaking the bot token.

### Version safety rules

- The version string comes from `package.json` only — never from environment
  variables or user input.
- The version field in `GET /health` must not be confused with `botToken`,
  `chatId`, or any other credential. The health report serialiser never writes
  those fields.
- Changing the `package.json` `"version"` is the only required step to stamp a
  new release across all surfaces.

## Out of scope for fixtures

- Signing transactions or holding keys
- Real `@BotFather` tokens or production chat ids
- Changing Mimir contract semantics
- Making CI depend on live RPC or Telegram
