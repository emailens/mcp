# Changelog

## 0.4.1

### Added

- **Remote server endpoint** — Available at `https://emailens.dev/api/mcp`. No install needed — point your MCP client to the URL with an API key. All 7 analysis tools run server-side.
- **MCP prompts** — 3 built-in prompts (`analyze-email`, `fix-email`, `check-domain`) for guided workflows.
- **Public tools** — `list_clients` and `check_deliverability` work without an API key (IP rate-limited at 30/min). Other tools still require auth.
- **Official MCP Registry** — Published as `io.github.emailens/mcp`. Also listed on Smithery, mcp.so, glama.ai, and mcpservers.org.
- **`mcpName` field** — Added to `package.json` for registry compliance.

### Fixed

- Tool discovery (initialize, tools/list) now works without authentication so directory scanners and MCP clients can read the tool catalog before connecting with a key.

## 0.4.0

### Breaking Changes

- **`analyze_email` returns CSS-only results.** Previously returned full audit (spam, links, a11y, images). Use `audit_email` for the full quality report.

### New Tools

- **`diff_emails`** — Compare two email HTML versions. Shows per-client score changes, fixed issues, and newly introduced issues.
- **`check_deliverability`** — Check SPF, DKIM, DMARC, MX, and BIMI records for a domain. Runs locally via DNS (no API key needed).
- **`capture_screenshots`** — Capture real browser screenshots across 15 email clients. Requires `EMAILENS_API_KEY`. Free plan: 30 previews/day.
- **`share_preview`** — Create shareable preview links. Requires `EMAILENS_API_KEY` and Dev plan ($9/mo).

### Enhancements

- **Engine upgrade to v0.9.1** — 15 email clients (added Outlook iOS and Outlook Android), improved `toPlainText()`, session API for faster analysis.
- **`preview_email`** — Now includes inbox preview (subject + preheader) and size report (Gmail clipping detection). Uses session API for single DOM parse.
- **`audit_email`** — Now includes inbox preview, size report, and template variable detection sections.
- **`list_clients`** — Returns 15 clients with `deprecated` field for Outlook Windows Legacy (Oct 2026).
- **Hosted tool support** — Set `EMAILENS_API_KEY` env var to unlock `capture_screenshots` and `share_preview`. Tools always appear in the tool list with clear upgrade guidance when no key is configured.

## 0.3.3

- Added `audit_email` tool for comprehensive quality analysis
- Added `toPlainText` output in `preview_email`

## 0.3.0

- Initial release with `preview_email`, `analyze_email`, `fix_email`, `list_clients`
