# Testing guide

The test suite is deterministic and does not need a Stellar RPC endpoint, a
Telegram bot token, or signing keys. Keep those credentials out of fixtures and
test output.

## Run the clean-checkout checks

```bash
npm ci
npm run typecheck
npm test
```

`npm test` builds `src/` into `dist/` first, then runs every `tests/*.test.mjs`
file with Node's built-in test runner. Run the same command used by CI when
reviewing a change.

## Fixture boundaries

- Use stable strings for contract ids, cursors, ledgers, and transaction hashes.
- Use in-memory fakes for RPC responses and Telegram sends; never call Testnet
  or Telegram from automated tests.
- Exercise both successful and rejected promises for RPC and notification
  paths. A failed notification must not make a test depend on retry timing.
- Use a temporary cursor path for persistence tests and remove it in cleanup,
  including when an assertion fails.
- Assert the observable safety contract: cursors are not advanced after an RPC
  failure, notification failures are counted, and secrets are absent from
  logs and error messages.

When a behavior depends on live chain data, keep that verification in a manual
`npm run scan` session and record the bounded command and result separately from
the automated suite.
