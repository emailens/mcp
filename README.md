<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./docs/wordmark-dark.svg">
  <img src="./docs/wordmark-light.svg" alt="emailens / mcp" width="444">
</picture>

**Email rendering analysis for AI assistants**

[![CI](https://github.com/emailens/mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/emailens/mcp/actions/workflows/ci.yml)
[![npm](https://badgen.net/npm/v/@emailens/mcp)](https://www.npmjs.com/package/@emailens/mcp)
[![license](https://badgen.net/badge/license/MIT/green)](./LICENSE)
[![MCP Registry](https://badgen.net/badge/MCP/Registry/blue)](https://registry.modelcontextprotocol.io)
[![Smithery](https://badgen.net/badge/Smithery/listed/orange)](https://smithery.ai/servers/emailens-mcp/emailens-mcp)
[![GitHub stars](https://badgen.net/github/stars/emailens/mcp)](https://github.com/emailens/mcp/stargazers)

</div>

MCP server for email compatibility analysis. Analyze, preview, diff, and fix emails across 21 email clients, plus capture real screenshots and create shareable links with an optional API key.

Send **HTML, MJML, Maizzle or React Email**. Set `format` and the template is compiled before analysis, so what gets checked is the HTML your readers actually receive.

Why your assistant needs this: across the 298 CSS and HTML features we track, only 6 are fully supported in every major email client ([see the data](https://emailens.dev/email-css/report)). Ask Claude to check your email before you send it.

Built on [`@emailens/engine`](https://github.com/emailens/engine). Also available as a [GitHub Action](https://github.com/marketplace/actions/emailens-email-preview-check).

## Install

```bash
npx -y @emailens/mcp
```

## Setup

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "emailens": {
      "command": "npx",
      "args": ["-y", "@emailens/mcp"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add emailens -- npx -y @emailens/mcp
```

### With API Key (optional, unlocks screenshots + sharing)

```json
{
  "mcpServers": {
    "emailens": {
      "command": "npx",
      "args": ["-y", "@emailens/mcp"],
      "env": {
        "EMAILENS_API_KEY": "ek_live_..."
      }
    }
  }
}
```

Get your free API key at [app.emailens.dev/dashboard/api](https://app.emailens.dev/dashboard/api?utm_source=mcp).

### Remote (no install)

Use the hosted endpoint: no npm or Node.js needed. API key required.

```json
{
  "mcpServers": {
    "emailens": {
      "url": "https://app.emailens.dev/api/mcp",
      "headers": {
        "Authorization": "Bearer ek_live_..."
      }
    }
  }
}
```

## Tools

### Local Tools (no account needed)

#### `preview_email`

Full email compatibility preview: transforms HTML for 21 clients, analyzes CSS, generates scores, simulates dark mode, checks inbox preview and email size.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `html` | string | One of | Email HTML source |
| `path` | string | One of | Absolute path to the source file instead of `html` (`.html`, `.htm`, `.mjml`, `.jsx`, `.tsx`, `.vue`); the extension sets `format` |
| `clients` | string[] | No | Filter to specific client IDs |
| `format` | enum | No | `"html"`, `"jsx"`, `"mjml"`, `"maizzle"` |

#### `analyze_email`

Quick CSS compatibility analysis; returns per-client scores and one finding per problem. Faster than `audit_email` when you only need CSS compatibility.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `html` | string | One of | Email HTML source |
| `path` | string | One of | Absolute path to the source file instead of `html` (`.html`, `.htm`, `.mjml`, `.jsx`, `.tsx`, `.vue`); the extension sets `format` |
| `format` | enum | No | Input format |
| `detail` | enum | No | `"summary"` (default) or `"full"` |
| `clients` | string[] | No | Only report these client IDs |
| `targetingPolicy` | enum | No | `"progressive"` (default), `"strict"`, or `"lenient"` |

**One finding per problem, not one per client.** The engine reports per client
because a score is per client, and per selector because a fix is per selector.
On an ordinary newsletter `border-radius` arrives twelve times (two clients
that drop it, six selectors that use it) with the same sentence in every copy.
That was 286KB of JSON, about 73,000 tokens, for an 11KB email.

Findings group by property, severity and message, listing the clients affected,
with positions merged across all of them. The same email now returns 40KB.

```json
{
  "property": "border-radius",
  "severity": "warning",
  "clients": ["outlook-windows", "outlook-windows-legacy"],
  "message": "Does not support \"border-radius\". Round corners can be used in VML…",
  "fixType": "structural",
  "hasFix": true,
  "loc": { "line": 61, "column": 28, "offset": 2753, "length": 171 },
  "alsoAtLines": [62, 64, 75, 78, 87]
}
```

Fix snippets are not included; they were 93KB of that 286KB, and `fix_email`
produces them for the issues you decide to act on. `hasFix` tells you one is
available; `fixType` tells you whether the repair is markup or CSS.

Pass `detail: "full"` for the engine's per-client shape with snippets, and
`clients: ["gmail-web", "outlook-windows"]` to report only what you care about:
the fastest further saving, roughly halving the response for two clients.
Scores stay whole-email either way: narrowing the report does not change what
the email is worth elsewhere. An unknown client ID is rejected by name; an
empty result would read as "this email is fine for that client".

**Source positions.** For HTML input, every warning carries `loc` (`line`,
`column`, `offset`, `length`) for the first occurrence, plus `alsoAtLines` for
any others, so an assistant can edit the exact source and knows where the rest
are. `audit_email` positions its other findings the same way.

```json
{
  "property": "border-radius",
  "loc": { "line": 7, "column": 8, "offset": 142, "length": 25 },
  "alsoAtLines": [12, 19]
}
```

Later occurrences are line numbers rather than full positions on purpose: this
response is read by a model paying for every token, and a real newsletter can
produce over a thousand occurrences; carrying them all in full nearly doubles
the payload.

Positions are reported for `html` input only. JSX, MJML and Maizzle are compiled
before analysis, so a line number would point into generated output rather than
the file you have open: the tools omit it instead of returning one that looks
authoritative.

#### `audit_email`

Comprehensive quality audit: CSS compatibility, spam scoring, link validation, accessibility, images, inbox preview, size (Gmail clipping), template variables, content overflow, visual bugs, dark-mode and mobile text contrast, design consistency, and client targeting.

The last three cover what a light desktop preview cannot show: text that disappears when a client forces dark mode or when the email's own dark block repaints a surface without re-colouring the text on it, contrast below the email's breakpoint, and colours that differ by value but not to a reader.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `html` | string | One of | Email HTML source |
| `path` | string | One of | Absolute path to the source file instead of `html` (`.html`, `.htm`, `.mjml`, `.jsx`, `.tsx`, `.vue`); the extension sets `format` |
| `format` | enum | No | Input format |
| `detail` | enum | No | `"summary"` (default) or `"full"` |
| `clients` | string[] | No | Only report these client IDs |
| `skip` | string[] | No | Checks to skip (e.g. `["spam", "images"]`) |
| `targetingPolicy` | enum | No | `"progressive"` (default), `"strict"`, or `"lenient"` |
| `emailType` | enum | No | `"transactional"` (no unsubscribe link required) or `"marketing"`. Omitted: guessed from the content |
| `previousHtml` | string | No | The design to hold this version to, usually your first draft. Omitted: the first version of this email audited in the session. What the edits removed comes back as `designRemovals` |

Fix `error` and `warning` findings. `info` findings are not problems: the email falls back safely there, so never remove responsive (`@media`) or dark-mode CSS to clear them.

#### `fix_email`

Generate a structured fix prompt for compatibility issues. Returns markdown with fix instructions that the AI can apply directly.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `html` | string | One of | Email HTML to fix |
| `path` | string | One of | Absolute path to the source file instead of `html` (`.html`, `.htm`, `.mjml`, `.jsx`, `.tsx`, `.vue`); the extension sets `format` |
| `format` | enum | No | Controls fix syntax |
| `scope` | enum | No | `"all"` or `"current"` |
| `selectedClientId` | string | No | Client ID for scoped fixes |

#### `list_clients`

List all 21 supported email clients with IDs, names, engines, and dark mode support.

#### `diff_emails`

Compare two email HTML versions; shows score changes, fixed issues, and introduced issues per client.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `before` / `beforePath` | string | One of | Original email source, or its file |
| `after` / `afterPath` | string | One of | Modified email source, or its file |
| `format` | enum | No | Input format |

#### `check_deliverability`

Check email deliverability for a domain: SPF, DKIM, DMARC, MX, BIMI records with a score and actionable issues.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `domain` | string | Yes | Domain to check (e.g. `"company.com"`) |

### Hosted Tools (require `EMAILENS_API_KEY`)

#### `capture_screenshots`

Capture real email screenshots across 21 clients in real browsers. Screenshots are hosted on CDN.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `html` | string | One of | Email HTML source |
| `path` | string | One of | Absolute path to the source file instead of `html` (`.html`, `.htm`, `.mjml`, `.jsx`, `.tsx`, `.vue`); the extension sets `format` |
| `format` | enum | No | Input format |
| `clients` | string[] | No | Filter clients |
| `modes` | string[] | No | `["light"]`, `["dark"]`, or `["light", "dark"]` |
| `title` | string | No | Name for the preview |

Free plan: 30 previews/day. [Sign up](https://emailens.dev/?utm_source=mcp)

#### `share_preview`

Create a shareable link. Recipients see the full analysis without an account.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `html` | string | One of | Email HTML source |
| `path` | string | One of | Absolute path to the source file instead of `html` (`.html`, `.htm`, `.mjml`, `.jsx`, `.tsx`, `.vue`); the extension sets `format` |
| `title` | string | No | Display title |
| `format` | enum | No | Input format |

Requires Dev plan ($9/mo). Share links expire after 7 days (Dev) or never (Pro).

## Template formats

`format` accepts `html` (the default), `mjml`, `maizzle` and `jsx` (React
Email). `maizzle` is an HTML template or a Vue single-file component. A pasted
Vue file with no `format` is compiled as `maizzle`. Anything but `html` is
compiled before analysis and also decides the syntax the fix snippets come back in.

Compiling matters more than it sounds. An email client renders the *output*, so
that is what has to be checked: handed a raw `<mjml>` document, an HTML parser
finds no CSS in it and reports a perfectly clean email. An answer like that is
worse than an error, because an assistant will repeat it.

**The compilers are not bundled.** MJML alone pulls 56MB, and this server is
usually started with `npx`, so the engine keeps them as optional peer
dependencies:

```bash
npm install mjml                                              # MJML
npm install @maizzle/framework@5                             # Maizzle HTML
npm install @maizzle/framework@6                             # Maizzle Vue single-file components
npm install sucrase react @react-email/components @react-email/render  # React Email
```

They have to be installed where the server runs, which is not always somewhere
you control. If it is not, compile the template yourself and send the resulting
HTML with `format: "html"`: the tools say so when they hit this.

## Supported Email Clients (21)

Each client links to its CSS support page. Setup guides for every assistant: [emailens.dev/mcp](https://emailens.dev/mcp).

| Client | ID | Dark Mode | Notes |
|---|---|---|---|
| [Gmail](https://emailens.dev/email-css/clients/gmail-web) | `gmail-web` | Yes | |
| [Gmail Android](https://emailens.dev/email-css/clients/gmail-android) | `gmail-android` | Yes | |
| [Gmail iOS](https://emailens.dev/email-css/clients/gmail-ios) | `gmail-ios` | Yes | |
| [Outlook 365](https://emailens.dev/email-css/clients/outlook-web) | `outlook-web` | Yes | |
| [Outlook Windows](https://emailens.dev/email-css/clients/outlook-windows) | `outlook-windows` | No | |
| [Outlook Windows Legacy](https://emailens.dev/email-css/clients/outlook-windows-legacy) | `outlook-windows-legacy` | No | Deprecated Oct 2026 |
| [Outlook iOS](https://emailens.dev/email-css/clients/outlook-ios) | `outlook-ios` | Yes | New in v0.4.0 |
| [Outlook Android](https://emailens.dev/email-css/clients/outlook-android) | `outlook-android` | Yes | New in v0.4.0 |
| [Outlook for Mac](https://emailens.dev/email-css/clients/outlook-macos) | `outlook-macos` | Yes | New in v0.10.0 |
| [Apple Mail](https://emailens.dev/email-css/clients/apple-mail-macos) | `apple-mail-macos` | Yes | |
| [Apple Mail iOS](https://emailens.dev/email-css/clients/apple-mail-ios) | `apple-mail-ios` | Yes | |
| [Yahoo Mail](https://emailens.dev/email-css/clients/yahoo-mail) | `yahoo-mail` | Yes | |
| [Yahoo Mail Android](https://emailens.dev/email-css/clients/yahoo-mail-android) | `yahoo-mail-android` | Yes | New in v0.10.0 |
| [Yahoo Mail iOS](https://emailens.dev/email-css/clients/yahoo-mail-ios) | `yahoo-mail-ios` | Yes | New in v0.10.0 |
| [Samsung Mail](https://emailens.dev/email-css/clients/samsung-mail) | `samsung-mail` | Yes | |
| [Thunderbird](https://emailens.dev/email-css/clients/thunderbird) | `thunderbird` | No | |
| [HEY Mail](https://emailens.dev/email-css/clients/hey-mail) | `hey-mail` | Yes | |
| [Proton Mail](https://emailens.dev/email-css/clients/protonmail) | `protonmail` | Yes | New in v0.10.0 |
| [AOL Mail](https://emailens.dev/email-css/clients/aol) | `aol` | Yes | New in v0.10.0 |
| [Fastmail](https://emailens.dev/email-css/clients/fastmail) | `fastmail` | Yes | New in v0.10.0 |
| [Superhuman](https://emailens.dev/email-css/clients/superhuman) | `superhuman` | Yes | |

## Releasing

Two publishes: npm, and the MCP registry. The registry listing sat five
releases behind because nothing pushed `server.json`, so that half is a
workflow now. [RELEASING.md](./RELEASING.md) has the details and the four
places the version has to agree.

## Development

```bash
bun install
bun run build
bun test
bun run typecheck
```

## License

MIT

---

If this saved you from an Outlook surprise, [a star](https://github.com/emailens/mcp) helps other email developers find it.
