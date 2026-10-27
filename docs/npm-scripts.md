# npm scripts

Every script defined in `package.json`'s `scripts` object, in one place. This
table is the single reference for what each script does, what it needs from the
environment, whether it touches the network, and whether it needs `dist/` to
exist first.

Run any script with `npm run <script>`. Arguments after `--` are passed to the
underlying command, for example `npm run scan -- --pages 40`.

**Environment variables** are listed as *required* (the command fails without
them) or *optional* (they change behaviour when set). A `.env` file in the
working directory is loaded by the scripts that read configuration; see
[`.env.example`](../.env.example) and
[docs/configuration-reference.md](configuration-reference.md) for the full list
and the defaults.

**Network access** means outbound traffic to a service other than this
machine. Loopback-only listeners (the mock RPC on `127.0.0.1:8420`, the local
health endpoint) are not external network access and are called out explicitly
where they matter.

**Build required** means the script executes a compiled file under `dist/`.
The build command is `npm run build` (`tsc -p tsconfig.json`); `dist/` is
gitignored, so a fresh checkout has to be built once.

| Script | Command | Purpose | Required environment variables | Network access | Build required |
|---|---|---|---|---|---|
| `dev` | `tsx watch src/index.ts` | Runs the bot from TypeScript source in watch mode, restarting on every file change. Same runtime path as `npm start`, but transpiled on the fly and without type-checking. | Required: `BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `MARKET_CONTRACT_ID`, `SQUAD_CONTRACT_ID`<br>Optional: `STELLAR_NETWORK`, `STELLAR_RPC_URL`, `STELLAR_HORIZON_URL`, `STELLAR_NETWORK_PASSPHRASE`, `STELLAR_EXPLORER_BASE_URL`, `MARKET_CONTRACT_VERSION`, `SQUAD_CONTRACT_VERSION`, `POLL_INTERVAL_MS`, `START_LOOKBACK_LEDGERS`, `CURSOR_FILE`, `INSTANCE_LOCK_FILE`, `STATUS_FILE`, `HEALTH_HOST`, `HEALTH_PORT`, `METRICS_PORT`, `NOTIFY_ENABLED`, `NOTIFY_MARKET`, `NOTIFY_SQUAD`, `SILENT_EVENTS`, `ALLOWED_CHAT_IDS`, `OPERATOR_TELEGRAM_USER_ID`, `MIMIR_LOCALE`, `LOG_LEVEL`, `LOG_FORMAT` | Yes — reads the Soroban RPC and delivers notifications to the Telegram Bot API | No — runs from `src/` through `tsx` |
| `start` | `node dist/index.js` | Runs the compiled bot in production mode. `npm start -- --status` prints the last status snapshot instead of booting the bot. | Required: `BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `MARKET_CONTRACT_ID`, `SQUAD_CONTRACT_ID`<br>Optional: same set as `dev` | Yes — reads the Soroban RPC and delivers notifications to the Telegram Bot API | **Yes** — executes `dist/index.js`; run `npm run build` first |
| `build` | `tsc -p tsconfig.json` | Compiles `src/` to `dist/`, type-checking on the way. The build command used by every other script and by the Docker image. | None | No | No — this *is* the build |
| `typecheck` | `tsc -p tsconfig.json --noEmit` | Type-checks the whole project without emitting any output. | None | No | No |
| `lockfile:check` | `node scripts/check-lockfile.mjs` | Offline consistency check of `package-lock.json` against `package.json`: lockfile version 3, root dependency ranges in sync, every package resolved to a `registry.npmjs.org` tarball with a `sha512` integrity hash, every direct dependency pinned at the top level. | None | No — reads only `package.json` and `package-lock.json` | No |
| `lockfile:reproduce` | `node scripts/check-lockfile.mjs --reproduce` | Runs the same consistency check and additionally asks npm to regenerate the lockfile from itself in a scratch directory, failing if the resolved package set changes. The repository working tree is never written to. | None | Yes — `npm install` in the scratch directory fetches from `registry.npmjs.org` | No |
| `test` | `npm run build && node --test --test-timeout=120000 tests/*.test.mjs` | Builds the project and runs the whole test suite with Node's built-in test runner. This is the same command CI runs. | None | No — the suite never contacts the Testnet RPC or the Telegram API | **Yes** — the script runs `npm run build` itself before the tests |
| `test:mock` | `npm run build && node --test --test-timeout=120000 tests/mock-*.test.mjs` | Builds the project and runs only the mock-profile suites (`tests/mock-*.test.mjs`). | None | No | **Yes** — the script runs `npm run build` itself before the tests |
| `test:fast` | `node --import ./scripts/tsx-dist-loader.mjs --test --test-timeout=120000 tests/*.test.mjs` | Runs the whole suite directly against `src/` using `tsx` as the transpiler: no `tsc`, no `dist/`. A loader shim rewrites `../dist/*.js` import specifiers to their `src/*.ts` counterparts. No type-checking. | None | No | No — deliberately skips the build; use `npm test` for the type-checked run |
| `scan` | `tsx src/stellar/events.ts` | Standalone chain scanner: walks contract events from the Soroban RPC with the cursor-paginated reader, decodes them, and prints a histogram plus a few sample events. Flags: `--pages`, `--show`, `--from`, `--contract`, `--json`, `--jsonl`, `--markdown`, `--mock`, `--help`. | Required: `MARKET_CONTRACT_ID`, `SQUAD_CONTRACT_ID`<br>Optional: `STELLAR_NETWORK`, `STELLAR_RPC_URL`, `STELLAR_HORIZON_URL`, `STELLAR_NETWORK_PASSPHRASE`, `MARKET_CONTRACT_VERSION`, `SQUAD_CONTRACT_VERSION` | Yes — reads the public Soroban RPC (`STELLAR_RPC_URL`, Testnet by default). No Telegram traffic | No |
| `scan:secrets` | `node scripts/scan-secrets.mjs` | Deterministic, zero-dependency scan of every tracked (and untracked-but-not-ignored) text file for secret-shaped strings. Exits 0 when clean, 1 with a redacted report on a finding, 2 when the scanner itself cannot run. | None | No — reads the working tree through `git ls-files`; no network, no credentials | No |
| `scan:mock` | `tsx src/stellar/events.ts --mock` | The same scanner pointed at the local mock Soroban RPC. `--mock` selects the `MIMIR_PROFILE=mock` defaults for anything the environment leaves unset, so no contract ids or credentials are needed. | None — the `mock` profile supplies the contract ids and the loopback RPC URL | No external network — connects to the local mock RPC on `127.0.0.1:8420`, so `npm run mock:rpc` must be running first | No |
| `mock:rpc` | `tsx src/stellar/mock-rpc.ts` | Serves the fixture scenario as a local Soroban JSON-RPC endpoint on `127.0.0.1:8420` (default port). Failure-injection flags: `--fail-events`, `--fail-health`, `--stale-cursor`, `--rate-limit`, `--fail-rpc`, `--malformed`, `--port`. | None | No — binds a loopback listener and serves in-memory fixtures | No |
| `mock:telegram` | `tsx src/dev/fake-telegram.ts` | Intended to run a local fake Telegram Bot API server that implements a subset of the Bot API (`getMe`, `sendMessage`, `setMyCommands`, `getUpdates`, `answerCallbackQuery`), prints what the bot sends, and never forwards to `api.telegram.org`. Point the bot at it with `TELEGRAM_API_ROOT=http://127.0.0.1:3001`. See [docs/fake-telegram.md](fake-telegram.md). | None required. The bot side reads `TELEGRAM_API_ROOT` (loopback only, optional). `FAKE_TELEGRAM_PORT` (optional, default 3001) is documented for the fake server itself in [docs/fake-telegram.md](fake-telegram.md) | No — loopback listener only, and it never contacts `api.telegram.org` | No |
| `mock:poll` | `tsx src/mock-run.ts` | Dry run for the mock profile: boots the in-process mock RPC, the real poller against it, and the local health endpoint, with a log-only notifier instead of Telegram. Flags: `--fail-events`, `--fail-health`, `--stale-cursor`, `--rate-limit`, `--malformed`, `--port`. | None — the `mock` profile supplies placeholder Telegram values so `loadConfig()` validates | No — the mock RPC runs in-process on loopback and Telegram is never contacted | No |
| `mock:stack` | `docker compose -f docker-compose.mock.yml up --build` | Brings up the containerised mock stack from `docker-compose.mock.yml`: a `mock-rpc` service and a `bot` service wired to it. | None for the script itself. The compose file sets `MIMIR_PROFILE=mock`, `NODE_ENV=development`, `STELLAR_RPC_URL`, `TELEGRAM_MODE` and `DRI_RUN` for its own services; `TELEGRAM_MODE` and `DRI_RUN` are not read by the application code | Yes — `docker compose up --build` runs `npm ci` inside the image build and pulls the `node:20-alpine` base image | No — the compose file builds the image itself; `npm run build` runs inside the Docker build |
| `mock:stack:down` | `docker compose -f docker-compose.mock.yml down -v` | Tears the mock stack down and removes its named volume. | None | No | No |
| `audit` | `tsx src/audit-cli.ts` | Renders the operator audit report from the JSONL audit log. Flags: `--tail`, `--json`, `--file`. | None | No — reads a local file | No |
| `audit:report` | `tsx src/audit-cli.ts` | The operator audit report — an alias of `audit` with an identical command, kept for discoverability. Same flags, same output. | None | No — reads a local file | No |
| `audit:check` | `tsx src/audit-check-cli.ts` | Schema-checks an audit JSONL file: JSON syntax, known audit kinds, detail-field size, timestamp ordering and format version. Exits non-zero when problems are found. Flag: `--file`. | None | No — reads a local file | No |
| `seed:cursor` | `tsx src/dev/seedCursor.ts` | Writes a deterministic version-1 cursor file so a local checkout can resume from a known position. Refuses to overwrite an existing cursor without `--force`. Flags: `--out`, `--force`, `--empty`, `--market-cursor`, `--market-ledger`, `--squad-cursor`, `--squad-ledger`. | None | No — writes a local file only | No |
| `cursor` | `node dist/cursor-cli.js` | Backs up or restores the validated cursor file. `backup` copies it to a timestamped `.bak`; `restore` reads a backup and replaces the live cursor while holding the poller's exclusive instance lock. Flags: `--file`, `--out`, `--from`, `--force`. | None required; optional `CURSOR_FILE`, `INSTANCE_LOCK_FILE`, `DOTENV_CONFIG_PATH` | No — never contacts Stellar or Telegram | **Yes** — executes `dist/cursor-cli.js`; run `npm run build` first |
| `replay` | `tsx src/replay-cli.ts` | Cursor-range replay: reads the events in a ledger range and, only when `--send` is passed, delivers them to Telegram. Never writes a cursor and never touches the live poller's state. Flags: `--from` (required), `--to`, `--send`, `--dry-run`, `--contract`, `--pages`, `--cap`, `--show`, `--json`, `--mock`, `--progress-file`, `--rpm`. | Required: `MARKET_CONTRACT_ID`, `SQUAD_CONTRACT_ID`; with `--send` also `BOT_TOKEN` and `TELEGRAM_CHAT_ID`<br>Optional: `STELLAR_NETWORK`, `STELLAR_RPC_URL`, `STELLAR_NETWORK_PASSPHRASE`, `MARKET_CONTRACT_VERSION`, `SQUAD_CONTRACT_VERSION` | Yes — reads the Soroban RPC; with `--send` it also calls the Telegram Bot API. Dry-run mode (the default) only touches the RPC | No |
| `replay:mock` | `tsx src/replay-cli.ts --mock` | The same replay against the local mock profile. Dry-run by default: no credentials, no Telegram. Flags are the same as `replay`. | None — the `mock` profile supplies the contract ids and the loopback RPC URL | No external network — reads the local mock RPC on `127.0.0.1:8420`, so `npm run mock:rpc` must be running first | No |
| `decode` | `tsx src/decode-cli.ts` | Intended to decode a Soroban event payload from the command line. The referenced entrypoint `src/decode-cli.ts` is not present in the repository, so this script currently fails on startup. The decoding logic itself lives in `src/stellar/decode.ts` and is reachable through `npm run scan -- --json` and the other CLIs. | None | No — the intended behaviour is a local, offline decode | No |
| `doctor` | `tsx src/doctor-cli.ts` | One-command environment check: Node version against `engines.node`, presence of the `.env` file, writability of the cursor directory, contract-id format, bot-token shape and chat-id format. Exits non-zero when any check fails; secret values are never printed. | None — it is a diagnostic. It reads `DOTENV_CONFIG_PATH`, `CURSOR_FILE`, `MARKET_CONTRACT_ID`, `SQUAD_CONTRACT_ID`, `BOT_TOKEN`, `TELEGRAM_CHAT_ID` and `MIMIR_PROFILE` from the environment or the `.env` file and reports on them | No — deliberately contacts no external service | No |
| `rpc-compare` | `tsx src/rpc-compare-cli.ts` | Reads the same contract and ledger range from two Soroban RPC endpoints and diffs the results, reporting missing, extra and differing events. Intended for operators switching RPC providers. Flags: `--rpc-a`, `--rpc-b`, `--contract` (all required), `--from`, `--to`, `--pages`, `--budget`, `--json`. | None — the endpoints and the contract id come from the command line, not the environment | Yes — contacts both RPC endpoints | No |

## Notes

**Building before you run.** Only `start` and `cursor` execute files from
`dist/`, and both need one prior build:

```bash
npm run build
```

`npm run build` is `tsc -p tsconfig.json`. `dist/` is gitignored, so a fresh
checkout has no `dist/` until it is built once. `npm test` and
`npm run test:mock` build as their first step, so they need no separate build;
`npm run test:fast` never builds at all, and `npm run typecheck` only
type-checks.

**The `mock` profile.** `MIMIR_PROFILE=mock` supplies defaults for every
setting the environment leaves unset: a loopback RPC URL, the fixture contract
ids, an isolated `data/cursor.mock.json` cursor, and placeholder Telegram
values. Explicit environment variables always win, so the profile can never
override a real deployment's configuration. `npm run scan:mock` and
`npm run replay:mock` set the profile themselves; `npm run mock:poll` does the
same. Any other profile name fails fast at startup.

**Loopback versus external network.** `mock:rpc`, `scan:mock`, `replay:mock`,
`mock:poll` and `mock:telegram` all stay on this machine. They still need a
listener on a local port, and `scan:mock` and `replay:mock` need
`npm run mock:rpc` running in another terminal first.

**Credentials are only needed to deliver.** The scanners, the replay in its
default dry-run mode, the audit CLIs, the cursor tools and the seed command
never authenticate against anything. `BOT_TOKEN` and `TELEGRAM_CHAT_ID` become
required as soon as a script actually delivers to Telegram: `npm run dev`,
`npm run start`, and `npm run replay -- --send`.

**Audit file location.** `npm run audit` and `npm run audit:check` default to
`./data/audit.jsonl` and take an explicit path through `--file`. The
`AUDIT_FILE` environment variable configures where the *bot* writes the audit
log; the two report CLIs do not read it.

**Scripts without an implementation.** `decode` and `mock:telegram` are declared
in `package.json` but their entrypoint files (`src/decode-cli.ts` and
`src/dev/fake-telegram.ts`) are not in the repository, so both currently fail
on startup. `mock:telegram` is still described in
[docs/fake-telegram.md](fake-telegram.md); `decode` has no dedicated
documentation.
