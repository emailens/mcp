# Changelog

## 0.6.1 — 2026-08-23

### Changed

- **A `loc` now points at the declaration, not the whole `style="…"` attribute.** An assistant editing by position gets the characters to change rather than the attribute containing them. Comes from `@emailens/engine` 0.10.3, and the dependency is pinned there because that is what the suite runs against — 0.6.0's `^0.10.2` already resolved to it for anyone installing after the engine's release.

## 0.6.0 — 2026-08-23

### Changed

- **`analyze_email` and `audit_email` return one finding per problem, not one per client — 86% smaller.** An ordinary 11KB newsletter produced **286KB of JSON, about 73,000 tokens**, and the audit 442KB. It is now 40KB and 62KB. A tool that cannot be called twice in a conversation gets called once and then avoided ([#3](https://github.com/emailens/mcp/issues/3)).

  The engine reports per client because a score is per client, and per selector because a fix is per selector. On that fixture `border-radius` arrived twelve times — two clients that drop it, six selectors that use it — carrying the same sentence and the same VML workaround in every copy. Findings now group by property, severity and message, listing the clients affected, with positions merged across all of them. 347 warnings become 65 findings.

  Three things make up the saving. The clients become a list instead of a reason to repeat the prose. The message loses the client's name, matched exactly against that client's own display name rather than by pattern, so it cannot eat a real word. And **`fix` snippets are gone** — 93KB of the original 286KB — replaced by `hasFix: true`, because `fix_email` exists to produce them for the issues a caller decides to act on. `fixType` stays: it is one word and it says whether the repair is markup or CSS.

  Where a suggestion differs between the clients in a group it is dropped rather than guessed, so one client's advice is never printed against another. Where a message names its client mid-sentence — the dark-mode warnings say "…so Apple Mail may keep the email in light mode" — the findings stay separate, because merging them would attribute Apple Mail's sentence to Samsung.

### Added

- **`detail: "full"`** returns the engine's per-client shape with fix snippets, unchanged. Nothing the collapsed form leaves out is unreachable.

- **`clients`** on both tools, to report only the clients you care about. The fastest further saving: two clients is 20KB rather than 40KB. Scores stay whole-email — asking about Outlook narrows the report, it does not change what the email is worth elsewhere. An id the engine does not know is rejected by name, rather than filtered to an empty list that would read as "this email is fine for that client".

## 0.5.1 — 2026-08-23

### Added

- **Source positions in `analyze_email` and `audit_email`.** For HTML input every finding tied to a specific place carries `loc` (line, column, offset, length) and, where one problem occurs in several places, `alsoAtLines` — so an assistant can edit the exact source rather than describe it, and can fix every occurrence instead of the first. Later occurrences are line numbers rather than full positions because this response is read by a model: on a real newsletter, carrying every occurrence in full grew the payload by 93% against 25% for the compact form. Positions are requested for `html` only: JSX, MJML and Maizzle are compiled before analysis, so a line number would refer to generated output the caller never wrote. Requires `@emailens/engine` 0.10.2.

### Fixed

- **`list_clients` advertised 15 clients.** Its tool description still said "List all 15 supported email clients" — the number an assistant reads before deciding whether to call it. There have been 21 since 0.10.0, and the description no longer names a count.

- **A test asserted Outlook Classic's end-of-support date.** It hardcoded `2026-10`; Microsoft moved the date, the engine's data followed, and the test failed on a fact it does not own. It now asserts what the tool actually owes its caller — the engine's answer, unaltered.

- **Two tests asserted 15 email clients.** The engine has shipped 21 since 0.10.0; they passed only against the lockfile's pinned 0.9.2. They now derive the count from `EMAIL_CLIENTS`.

## 0.5.0

### Enhancements

- **Engine upgrade to v0.10.0** — 21 email clients (added Outlook for Mac, Yahoo Mail Android/iOS, Proton Mail, AOL, Fastmail) and 255 tracked CSS/HTML features with value-aware, note-driven partial-support warnings.
- **`audit_email`** — Now includes content overflow and visual bug sections. New `skip` values: `overflow`, `visual`.
- **`preview_email`** — Result now surfaces content overflow and visual bug findings.
- **`fix_email`** — Fix prompts now incorporate overflow and visual issues so AI fixes cover layout and rendering, not just CSS compatibility.

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
