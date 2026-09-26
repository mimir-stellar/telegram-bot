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

CI runs typecheck, build, and the full test suite on every push and pull request.
No live Testnet RPC access, Telegram credentials, or signing keys are required.

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
| `tests/fixtures.test.mjs` | Loads the fixture catalog and asserts notify / skip / boundary behaviour |
| `tests/format.test.mjs` | Inline unit cases (MarkdownV2 escape, USDC decimals, send failures) |
| `tests/logexport.test.mjs` | Log export: redaction, ring bounds, console wiring, secret-leak regressions |
| `tests/version.test.mjs` | Release version metadata: positive, negative, boundary, restart, and regression coverage for `APP_VERSION`, health report, liveness endpoint, and log export header |

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
5. **Log-export tests assert on a fake token** (e.g. `0000000000:SECRET-TOKEN-DO-NOT-LEAK`)
   and assert the redaction *removed* it — never verify redaction by pasting a
   real-looking credential and checking it survived anywhere.

### Case kinds (what to cover)

| `kind` | Intent | Typical `expect` |
| --- | --- | --- |
| `positive` | Happy-path notification for a known market/squad event | `notify` |
| `negative` | Malformed / unknown / admin-shaped payload → no chat message | `skip` |
| `boundary` | Clipping, reserved MarkdownV2 chars, zero/max amounts | `notify` or `skip` |
| `restart` | Documents cursor resume / corrupt-file cold start (see cursor fixtures) | n/a in format suite |

`expect: "notify"` requires a non-null MarkdownV2 string from `formatEvent`.
`expect: "skip"` requires `null` (or an `unknown` payload that the poller would
log and not post).

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

## Log capture and the `/export` command

The bot keeps a bounded in-memory ring of its own redacted console lines
(`LOG_BUFFER_LINES`, default 500, `0` disables) and renders it for operators via
the `/export` command and `GET /health/diag`. Invariants the tests hold in
place (`tests/logexport.test.mjs`):

- Redaction happens **on capture**, before storage — a secret must never sit in
  the buffer, and the rendered export is redacted again as a final net.
- The ring evicts the oldest line when full; there is no unbounded retention.
- The export is plain text with no parse mode, so log content cannot inject
  MarkdownV2 entities.
- Capture is in-memory only: a restart starts with an empty ring, and nothing
  is written to `data/` or anywhere else.

## Version metadata

The bot surfaces the version from `package.json` at runtime via the `APP_VERSION`
constant in `src/config.ts` (read once with `createRequire` at module load, falls
back to `"unknown"` if the field is absent). It appears in:

- `[boot]` log line — `Mimir Telegram notifier vX.Y.Z`
- `/status` command header — `running on Stellar testnet (vX.Y.Z)`
- Log export header — `Mimir notifier log export · vX.Y.Z`
- `GET /health` JSON body — `"version": "X.Y.Z"`
- `GET /health/live` JSON body — `"version": "X.Y.Z"`

`tests/version.test.mjs` holds the authoritative test suite for these surfaces.
The version string is **not** included in `secretsFor()` and must never be added
there — it is public metadata, not a credential.

When bumping the version in `package.json`, no other files need manual edits.

## Out of scope for fixtures

- Signing transactions or holding keys
- Real `@BotFather` tokens or production chat ids
- Changing Mimir contract semantics
- Making CI depend on live RPC or Telegram
