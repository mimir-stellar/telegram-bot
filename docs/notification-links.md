# Notification link safety

Every notification renderer (MarkdownV2 `formatEvent`, Telegram HTML
`formatEventHtml`, plain text `formatPlainTextEvent`, both malformed-payload
fallbacks, and the inline keyboard) decides whether a URL may become a
clickable link through one shared policy in
[`src/notifications/link-safety.ts`](../src/notifications/link-safety.ts).

## Allowed links

| Link | Source | Allowed scheme |
| --- | --- | --- |
| Transaction explorer (`tx` footer link and explorer button) | `STELLAR_EXPLORER_BASE_URL` (default `https://stellar.expert/explorer`) + 64-hex tx hash | `https:` |
| Mimir web app button | `MIMIR_APP_URL` + `/claims/<id>` or `/squads/<id>` | `https:` |

`SAFE_LINK_PROTOCOLS` is `["https:"]`. A URL is linked only when it also:

- parses as a URL with a host,
- carries no userinfo (`user:pass@`),
- contains no whitespace, control, bidi-override or zero-width characters,
- is at most `MAX_LINK_LENGTH` (2048) characters.

`STELLAR_EXPLORER_BASE_URL` still accepts `http://` at config load (for local
explorers), but an `http:` explorer produces no clickable link: notifications
show the inert `tx` label instead.

## Unsafe links render as inert text

When an event has a well-formed transaction hash but its URL fails the policy
(for example a hand-built config with `javascript:`, `data:`, `tg:`, `file:` or
`http:` origins), the renderers keep the `tx` label but drop the link:

| Renderer | Safe URL | Unsafe URL |
| --- | --- | --- |
| MarkdownV2 footer / fallback | `_ledger 42_ · [tx](https://…)` | `_ledger 42_ · tx` |
| HTML footer / fallback | `<i>ledger 42</i> · <a href="https://…">tx</a>` | `<i>ledger 42</i> · tx` |
| Plain text | `ledger 42` + `tx: https://…` | `ledger 42` |
| Inline keyboard | explorer / app button | no button |

The rejected URL is never echoed into the message. An event with no hash
renders no `tx` part at all, as before. The fallbacks previously emitted an
empty `[tx]()` for a malformed hash; they now render inert `tx` text too.

MarkdownV2 link targets are escaped with `escapeMdLinkUrl` (`)` and `\`), and
HTML `href` values with `escapeHtmlAttr`.

## Adding a new link

Route any new URL through `safeLinkUrl()` (or `linkHtml()` for HTML) rather
than checking the protocol inline, and add a case to
`tests/link-safety.test.mjs`.
