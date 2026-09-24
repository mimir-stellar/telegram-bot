# Incident Runbook

Operational guidance for recovering the Mimir Telegram notifier from missed notifications, without treating Telegram as the source of truth.

## Operating principles

* Stellar chain state is the source of truth.
* The notifier is read-only and never holds signing keys or private keys.
* A notification failure must not alter on-chain state.
* Cursors must only move according to the poller's existing persistence rules.
* Logs and status output must not expose bot tokens, private keys, payment proofs, or unbounded remote payloads.

## Quick health check

Run:

```bash
/status
```

Check:

* current chain tip
* RPC retained-history floor
* watched contract IDs
* last event ledger per contract
* persisted cursor
* poll/send counters
* last error

For a read-only chain diagnostic without a Telegram token:

```bash
npm run scan
```

Use `--from`, `--pages`, or `--show` when a narrower or deeper scan is needed.

## RPC failures

### Symptoms

* `/status` reports a recent RPC error.
* One contract stops advancing while the other continues.
* Notifications from one contract are missing.

### Recovery

1. Confirm the RPC endpoint is reachable.
2. Run `npm run scan` to verify that the chain reader can access retained events.
3. Check the retained-history floor reported by the RPC.
4. Restart the process only if the underlying RPC problem has been resolved.

The affected contract's cursor is left unchanged after a failed scan, so the next polling cycle can retry from the same position.

Do not manually advance the cursor to skip an RPC failure.

## Telegram failures

### Symptoms

* Event scanning continues but sends fail.
* `/status` shows send errors or an increasing scan/send difference.
* The bot was removed from the chat or its token was revoked.

### Recovery

1. Confirm the bot token and chat configuration are valid.
2. Confirm the bot is still present in the target chat and has permission to post.
3. Use `/status` to confirm the process is still running.
4. Restart only when configuration has been corrected.

Telegram delivery is intentionally lossy. A failed send does not hold the cursor back because replaying every missed notification could create an unbounded backlog or flood a recovered chat.

The Stellar chain remains the authoritative record.

## Stale or corrupt cursor

### Symptoms

* The cursor cannot be parsed.
* The stored cursor is incompatible with the current cursor format.
* The process reports a cursor-loading problem.

### Recovery

A corrupt cursor is treated as a cold start.

Before changing `CURSOR_FILE` or deleting persisted state, preserve the existing file for investigation if possible.

On a cold start, the poller begins from its configured lookback rather than replaying the entire retained RPC history.

Never replace a cursor with an arbitrary ledger or cursor value unless the repository's cursor format and retained-history requirements have been verified.

## Process restart

### Persistent deployment

Ensure `data/` or the path configured by `CURSOR_FILE` is on persistent storage.

After a restart:

1. Check `/status`.
2. Confirm the persisted cursor is present.
3. Confirm polling resumes normally.
4. Check that counters and last-event ledgers begin advancing again.

### Ephemeral deployment

If the filesystem is ephemeral, every restart behaves like a cold start. Events that occurred while the process was down may not be posted.

Use persistent storage for long-running deployments.

## Rate limiting

Notification bursts are bounded by `MAX_NOTIFICATIONS_PER_CYCLE` and spaced out.

If Telegram rate limits are observed:

1. Confirm the process remains alive.
2. Check `/status` for send errors.
3. Do not disable the notification cap to compensate.
4. Allow subsequent polling cycles to continue normally.

Do not manually replay large event ranges into Telegram.

## Malformed or unexpected events

A malformed event must not crash the long-running process.

When investigating:

1. Use `npm run scan` to inspect the affected event range.
2. Confirm the contract and ledger involved.
3. Check the decoded event output without copying unrestricted remote payloads into logs or tickets.
4. Preserve the existing cursor behavior.

Do not modify on-chain state or attempt to repair an event by writing to the Mimir contracts.

## Safe rollback

For a deployment containing only documentation or operational changes:

1. Stop or pause the affected deployment according to its hosting platform's procedure.
2. Revert to the previously known-good application revision.
3. Preserve the persistent `data/` volume.
4. Restart the known-good revision.
5. Check `/status`.
6. Verify that the persisted cursor is still present and polling resumes.

Do not delete cursor state as part of a normal rollback.

## Deployment checklist

Before deployment:

* `.env` contains valid configuration without exposing secrets in source control.
* `BOT_TOKEN` and `TELEGRAM_CHAT_ID` are supplied through the deployment secret/configuration mechanism.
* `data/` or `CURSOR_FILE` is persistent.
* The deployed revision passes typecheck and build checks.
* No production credentials are committed.

After deployment:

* Confirm the process starts successfully.
* Run `/status`.
* Confirm the expected contract IDs and cursor are shown.
* Confirm the last event ledger advances after new events.
* Monitor RPC and Telegram errors.

## Security and logging

Never log:

* Telegram bot tokens
* private keys or signing material
* payment proofs
* unrestricted remote API responses
* sensitive authentication data

When reporting an incident, include only the minimum information needed to identify the failure, such as contract, ledger, cursor state, error category, and timestamp.

## Verification

Before merging operational changes, run the repository's documented checks:

```bash
npm run typecheck
npm run build
npm test
```

Also verify the command-level diagnostic path where applicable:

```bash
npm run scan
```

The notifier should remain read-only throughout incident recovery. The chain remains the source of truth even when Telegram delivery is unavailable.
