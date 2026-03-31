# @emailens/mcp

MCP server for email compatibility analysis. Analyze, preview, diff, and fix HTML emails across 15 email clients — plus capture real screenshots and create shareable links with an optional API key.

Built on [`@emailens/engine`](https://github.com/emailens/engine).

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

### With API Key (optional — unlocks screenshots + sharing)

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

Get your free API key at [emailens.dev/settings/api-keys](https://emailens.dev/settings/api-keys).

## Tools

### Local Tools (no account needed)

#### `preview_email`

Full email compatibility preview — transforms HTML for 15 clients, analyzes CSS, generates scores, simulates dark mode, checks inbox preview and email size.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `html` | string | Yes | Email HTML source |
| `clients` | string[] | No | Filter to specific client IDs |
| `format` | enum | No | `"html"`, `"jsx"`, `"mjml"`, `"maizzle"` |

#### `analyze_email`

Quick CSS compatibility analysis — returns per-client scores and warnings. Faster than `audit_email` when you only need CSS compatibility.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `html` | string | Yes | Email HTML source |
| `format` | enum | No | Input format |

#### `audit_email`

Comprehensive quality audit — CSS compatibility, spam scoring, link validation, accessibility, images, inbox preview, size (Gmail clipping), and template variables.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `html` | string | Yes | Email HTML source |
| `format` | enum | No | Input format |
| `skip` | string[] | No | Checks to skip (e.g. `["spam", "images"]`) |

#### `fix_email`

Generate a structured fix prompt for compatibility issues. Returns markdown with fix instructions that the AI can apply directly.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `html` | string | Yes | Email HTML to fix |
| `format` | enum | No | Controls fix syntax |
| `scope` | enum | No | `"all"` or `"current"` |
| `selectedClientId` | string | No | Client ID for scoped fixes |

#### `list_clients`

List all 15 supported email clients with IDs, names, engines, and dark mode support.

#### `diff_emails`

Compare two email HTML versions — shows score changes, fixed issues, and introduced issues per client.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `before` | string | Yes | Original email HTML |
| `after` | string | Yes | Modified email HTML |
| `format` | enum | No | Input format |

#### `check_deliverability`

Check email deliverability for a domain — SPF, DKIM, DMARC, MX, BIMI records with a score and actionable issues.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `domain` | string | Yes | Domain to check (e.g. `"company.com"`) |

### Hosted Tools (require `EMAILENS_API_KEY`)

#### `capture_screenshots`

Capture real email screenshots across 15 clients in real browsers. Screenshots are hosted on CDN.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `html` | string | Yes | Email HTML source |
| `format` | enum | No | Input format |
| `clients` | string[] | No | Filter clients |
| `modes` | string[] | No | `["light"]`, `["dark"]`, or `["light", "dark"]` |
| `title` | string | No | Name for the preview |

Free plan: 30 previews/day. [Sign up](https://emailens.dev?ref=mcp)

#### `share_preview`

Create a shareable link. Recipients see the full analysis without an account.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `html` | string | Yes | Email HTML source |
| `title` | string | No | Display title |
| `format` | enum | No | Input format |

Requires Dev plan ($9/mo). Share links expire after 7 days (Dev) or never (Pro).

## Supported Email Clients (15)

| Client | ID | Dark Mode | Notes |
|---|---|---|---|
| Gmail | `gmail-web` | Yes | |
| Gmail Android | `gmail-android` | Yes | |
| Gmail iOS | `gmail-ios` | Yes | |
| Outlook 365 | `outlook-web` | Yes | |
| Outlook Windows | `outlook-windows` | No | |
| Outlook Windows Legacy | `outlook-windows-legacy` | No | Deprecated Oct 2026 |
| Outlook iOS | `outlook-ios` | Yes | New in v0.4.0 |
| Outlook Android | `outlook-android` | Yes | New in v0.4.0 |
| Apple Mail | `apple-mail-macos` | Yes | |
| Apple Mail iOS | `apple-mail-ios` | Yes | |
| Yahoo Mail | `yahoo-mail` | Yes | |
| Samsung Mail | `samsung-mail` | Yes | |
| Thunderbird | `thunderbird` | No | |
| HEY Mail | `hey-mail` | Yes | |
| Superhuman | `superhuman` | Yes | |

## Development

```bash
bun install
bun run build
bun test
bun run typecheck
```

## License

MIT
