# Event Feed Exports (Atom 1.0 & JSON Feed 1.1)

`src/stellar/feed.ts` builds read-only syndication feeds from decoded Mimir Soroban contract events (`DecodedEvent`). Both formats derive from the same canonical entry builder (`buildAtomEntry`) so entry IDs, ordering, timestamps, bounded plain-text content, and sanitized `https:` links stay consistent across formats.

## Formats

### Atom 1.0 (`buildAtomFeed`)

- Emits RFC 4287 Atom 1.0 XML (`application/atom+xml`).
- Escapes all XML text/attributes and strips XML-illegal C0 control characters.
- Entry `<id>` is a permanent tag URI scoped to network passphrase, contract ID, and chain event ID (`tag:mimir,event:<network>:<contract>:<eventId>`).
- Entry `<link rel="alternate">` is the sanitized `https:` explorer URL when available.

### Bounded JSON Feed 1.1 (`buildJsonFeed` / `buildJsonFeedDocument`)

- Emits a versioned [JSON Feed 1.1](https://jsonfeed.org/version/1.1) document (`version: "https://jsonfeed.org/version/1.1"`).
- Includes a versioned `_mimir` extension block (`schema_version: 1`) reporting `updated`, `total_items`, `max_items`, and `truncated`.
- Preserves input event ordering across the bounded slice (`events.slice(0, maxItems)`).

#### Bounds

| Bound | Constant | Default / Cap |
|---|---|---|
| Default max items | `JSON_FEED_DEFAULT_MAX_ITEMS` | `100` |
| Hard max items cap | `JSON_FEED_MAX_ITEMS_LIMIT` | `500` |
| Title / description length | `FEED_TITLE_MAX_CHARS` | `500` code points |
| Content text length | `FEED_CONTENT_MAX_CHARS` | `2000` code points |

Passing a negative, fractional, or non-finite `maxItems` throws a `RangeError`. Values above `JSON_FEED_MAX_ITEMS_LIMIT` are capped to `JSON_FEED_MAX_ITEMS_LIMIT`.

#### Link Sanitization

All URLs (`feed_url`, `home_page_url`, item `url`, and item `external_url`) are validated with `safeHttpsUrl` and omitted unless they use the `https:` scheme:

- `url`: sanitized explorer URL (matches Atom's `<link rel="alternate">`).
- `external_url`: sanitized Mimir web-app deep link built via `appUrlFor(event, config.mimirAppUrl)` (`src/notifications/app-links.ts`).
