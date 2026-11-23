# Operator support bundle

`npm run support-bundle` builds one redacted JSON document an operator can attach
to a bug report or incident ticket. It is an extension of the `doctor` and
incident-drill subsystem: read-only, credential-free, and safe to run on a
production host.

```bash
# Print a bundle for the local checkout
npm run support-bundle

# Include the health endpoint of a running instance
npm run support-bundle -- --health-url http://127.0.0.1:8787/health

# Write it to a file for an issue attachment
npm run support-bundle -- --out support-bundle.json
```

## What it collects

- **Schema versions** for the status snapshot, cursor file and counters file,
  plus the known schema version this build understands.
- **Health** from an optional `--health-url` probe: overall status, uptime,
  counters, per-target ledgers and flags, and a redacted `lastError`.
- **Status summary** from `STATUS_FILE` when the process is not exposing health.
- **Doctor checks** (environment, `.env`, contract ids, token shape, chat id).
- **Bounded error summaries** from health, status, doctor failures and
  unreadable state files. Every string is redacted and capped at 300 characters.

## What it never collects

- Bot tokens, seed/private keys, bearer tokens or URL credentials.
- Telegram message text or any other private chat content.
- A complete environment dump, config values, chat ids or the raw `.env` file.
- Unbounded remote RPC or Telegram payloads.

## Options

| Flag | Default | Purpose |
|---|---|---|
| `--status <path>` | `STATUS_FILE` or `./data/status.json` | Status snapshot to summarise |
| `--cursor <path>` | `CURSOR_FILE` or `./data/cursor.json` | Cursor file whose schema version is probed |
| `--counters <path>` | `COUNTERS_FILE` or `./data/counters.json` | Counters file whose schema version is probed |
| `--health-url <url>` | none | Optional health JSON endpoint to probe, usually loopback |
| `--out <path>` | stdout | Write the bundle to a file instead of printing it |

The command exits non-zero when the doctor finds a failing environment check,
but it still writes the bundle. Failed health probes or unreadable state files
are recorded as bounded diagnostics rather than aborting generation.

The bot remains read-only: this utility never holds signing keys, never submits
chain transactions, and never claims exactly-once notification delivery.
