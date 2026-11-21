# Analytics export

`npm run analytics:export` turns an event archive into one JSON document that
summarises what happened on chain: challenge-stake and squad-deposit volume per
UTC bucket, and how long claims took to resolve or be cancelled. It is built on
the same reducers the bot already uses (`src/stellar/volume-series.ts`,
`src/stellar/resolution-latency.ts`) and adds a stable, versioned envelope with
units, bounds and completeness fields.

```sh
npm run analytics:export -- --archive ./data/archive               # daily buckets, to stdout
npm run analytics:export -- --archive ./data/archive --bucket hour
npm run analytics:export -- --archive ./data/archive --out summary.json
```

The command is read-only. It never contacts the Soroban RPC or Telegram and
never writes the archive. Exit codes: `0` summary written, `1` the archive could
not be read (missing directory, malformed record), `2` bad flags.

From code, `buildAnalyticsSummary(events, { bucket })` and
`serializeAnalyticsSummary(summary)` in `src/stellar/analytics-export.ts` give
the same document.

## Contract

The schema is [`docs/schemas/analytics-summary.schema.json`](schemas/analytics-summary.schema.json).
Every document starts with:

```json
{ "schema": "mimir.analytics-summary", "schemaVersion": 1 }
```

Within a `schemaVersion`, fields are only added. Removing a field or changing
its type needs a new version, so a consumer can check `schemaVersion` once and
then rely on every field the schema declares.

## Determinism

The document is a pure function of the archived events:

- no `generatedAt`, host name or run id,
- fixed key order, two-space indent, one trailing newline,
- the order of events in the input does not change the output.

The same archive therefore always gives byte-identical output, which makes the
export safe to diff, hash or commit as a fixture.

## Units

| Field | Unit |
|---|---|
| `challengeStake`, `squadDeposit`, `totals.*` | Integer base units of the contract token, as a **decimal string** (i128 values do not fit a JSON number) |
| `*At` | Unix seconds, UTC. `*Iso` fields are the same instant as ISO-8601 |
| latency `seconds` / `ledgers` | Whole seconds and whole ledgers between the creation event and the end event |
| `units.bucket` | `hour` or `day`, aligned to UTC |
| `p50`, `p90` | Nearest-rank percentile over paired claims |

## Bounds

- `input.timeBounds` and `input.ledgerBounds`: earliest and latest `at` and
  `ledger` among usable events. `null` when there are none.
- `volume.bounds`: `startAt` is the first bucket's start (inclusive), `endAt` the
  end of the last bucket (exclusive), and `bucketCount` the number of buckets.
  Buckets are contiguous: gaps between events are zero-filled.

## Completeness

A summary can be accurate and still partial. The completeness fields say how
partial:

| Field | Meaning |
|---|---|
| `input.malformed` | Records that are not decoded events (null, not an object, no payload) |
| `input.missingTime` | Records with a missing, negative or non-finite `at` or `ledger` |
| `volume.completeness.processedEvents` | Events counted into buckets |
| `latency.completeness.pairedClaims` | Claims with both a creation and an end event |
| `latency.completeness.excludedClaims` | Claims seen without a creation event, or still open (no resolution or cancellation yet) |
| `complete` | `true` only when nothing above was dropped or left unpaired |

An open claim is normal on a live archive, so `complete: false` is a signal to
read the counts, not an error.
