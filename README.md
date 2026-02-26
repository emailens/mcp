# @emailens/mcp

MCP (Model Context Protocol) server for email compatibility analysis. Enables Claude and other MCP-compatible AI assistants to preview, analyze, and score HTML emails across 12 email clients.

Built on top of [`@emailens/engine`](https://github.com/emailens/engine).

## Install

```bash
npm install -g @emailens/mcp
# or
bunx @emailens/mcp
```

## Usage with Claude Desktop

Add to your Claude Desktop config (`claude_desktop_config.json`):

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

Or if using Bun:

```json
{
  "mcpServers": {
    "emailens": {
      "command": "bunx",
      "args": ["@emailens/mcp"]
    }
  }
}
```

## Usage with Claude Code

Add to your Claude Code settings:

```bash
claude mcp add emailens -- npx -y @emailens/mcp
```

## Tools

The server exposes four tools:

### `preview_email`

Full email compatibility preview — transforms HTML per client, analyzes CSS, generates scores, and simulates dark mode.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `html` | string | Yes | The email HTML source code |
| `clients` | string[] | No | Filter to specific client IDs (e.g. `["gmail_web", "outlook_windows"]`). Omit for all 12 clients. |
| `format` | enum | No | Input format: `"html"` (default), `"jsx"` (React Email), `"mjml"`, or `"maizzle"`. Controls which framework-specific fix snippets appear. |

**Returns:** JSON with `overallScore` (0–100), `compatibilityScores` (per-client), `cssWarnings` (with fix snippets), `clientCount`, and `darkModeWarnings`.

**Example prompt:**
> Analyze this email HTML and tell me what will break in Gmail and Outlook:
> ```html
> <div style="display: flex; gap: 16px; border-radius: 8px;">...</div>
> ```

### `analyze_email`

Quick CSS compatibility analysis — returns warnings and per-client scores without full transforms. Faster than `preview_email` when you only need the compatibility report.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `html` | string | Yes | The email HTML source code |
| `format` | enum | No | Input format: `"html"`, `"jsx"`, `"mjml"`, or `"maizzle"` |

**Returns:** JSON with `overallScore`, `scores` (per-client), `warningCount`, and `warnings` (with severity, message, and fix).

**Example prompt:**
> What's the compatibility score for this React Email template?

### `fix_email`

Generate a structured fix prompt for email compatibility issues. Analyzes the HTML, classifies each warning as CSS-only or structural (requires HTML restructuring), estimates token usage, and returns a markdown prompt the AI assistant can apply directly. Use after `preview_email` or `analyze_email` to fix the issues found.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `html` | string | Yes | The email HTML source code to fix |
| `format` | enum | No | Input format: `"html"` (default), `"jsx"`, `"mjml"`, or `"maizzle"`. Controls the fix syntax. |
| `scope` | enum | No | `"all"` (default) or `"current"` (requires `selectedClientId`) |
| `selectedClientId` | string | No | Client ID to scope fixes to (e.g. `"outlook-windows"`). Only used when scope is `"current"`. |

**Returns:** JSON with `totalWarnings`, `structuralWarnings`, `cssWarnings`, `tokenEstimate`, and the full fix prompt as markdown.

**Example prompt:**
> Fix this email HTML so it works in Outlook Windows — it uses flexbox and word-break which aren't supported.

### `list_clients`

Lists all 12 supported email client IDs, display names, categories, rendering engines, and dark mode support. Useful for discovering valid client IDs to pass to `preview_email` or `fix_email`.

**Parameters:** None

**Returns:** JSON array of `{ id, name, category, engine, darkModeSupport }` objects.

**Example prompt:**
> What email clients does Emailens support?

## Supported Email Clients

| Client | ID | Dark Mode |
|---|---|---|
| Gmail | `gmail-web` | Yes |
| Gmail Android | `gmail-android` | Yes |
| Gmail iOS | `gmail-ios` | Yes |
| Outlook 365 | `outlook-web` | Yes |
| Outlook Windows | `outlook-windows` | No |
| Apple Mail | `apple-mail-macos` | Yes |
| Apple Mail iOS | `apple-mail-ios` | Yes |
| Yahoo Mail | `yahoo-mail` | Yes |
| Samsung Mail | `samsung-mail` | Yes |
| Thunderbird | `thunderbird` | No |
| HEY Mail | `hey-mail` | Yes |
| Superhuman | `superhuman` | Yes |

## Framework-Aware Fixes

When you specify a `format`, the fix snippets in warnings are tailored to your framework:

- **`jsx`** — References React Email components (`Row`, `Column`, `Font`, `Container` from `@react-email/components`)
- **`mjml`** — References MJML elements (`mj-section`, `mj-column`, `mj-font`, `mj-style`)
- **`maizzle`** — References Tailwind CSS classes and Maizzle config (`googleFonts`, MSO conditionals)
- **`html`** (default) — Generic HTML with VML fallbacks for Outlook

## Fix Types (v0.2.0)

Every warning now includes a `fixType` field:

- **`css`** — Can be fixed with CSS swaps or fallbacks
- **`structural`** — Requires HTML restructuring (tables, VML, MSO conditionals). CSS-only changes will NOT work.

The `fix_email` tool uses this classification to generate targeted fix instructions that the AI assistant can apply directly.

## How It Works

The MCP server is a thin wrapper around `@emailens/engine`. For each tool call, it:

1. Validates inputs with Zod schemas
2. Calls engine functions (`transformForAllClients`, `analyzeEmail`, `generateCompatibilityScore`, `simulateDarkMode`, `generateFixPrompt`, `estimateAiFixTokens`)
3. Formats and returns JSON results via stdio transport

The engine uses [Cheerio](https://cheerio.js.org/) for HTML manipulation and [css-tree](https://github.com/csstree/csstree) for CSS parsing. No external API calls — all analysis and fix prompt generation runs locally. The `fix_email` tool generates a prompt for the AI assistant to apply — it does not call any AI API itself.

## Development

```bash
# Install dependencies
bun install

# Build
bun run build

# Run locally
bun run src/index.ts

# Type check
bun run typecheck
```

## License

MIT
