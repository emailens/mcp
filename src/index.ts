import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { collapseWarnings, forClients, knownClientIds } from "./findings.js";
import { resolveSourceFormat, toHtml } from "./compile.js";
import {
  createSession,
  analyzeEmail,
  generateCompatibilityScore,
  simulateDarkMode,
  transformForAllClients,
  transformForClient,
  generateFixPrompt,
  estimateAiFixTokens,
  diffResults,
  toPlainText,
  checkDesignRetention,
  EMAIL_CLIENTS,
  MAX_HTML_SIZE,
  type Framework,
  type CSSWarning,
  type SourceLocation,
} from "@emailens/engine";
// Lazy-imported: @emailens/engine/server may not exist in all engine versions
let _checkDeliverability: ((domain: string) => Promise<unknown>) | null = null;
import { config } from "./config.js";
import { firstDraft } from "./drafts.js";
import { readSource, withoutSource } from "./source.js";
import { apiRequest, mcpError, noApiKeyError } from "./hosted.js";

function toFramework(format?: string): Framework | undefined {
  if (format === "jsx" || format === "mjml" || format === "maizzle") return format;
  return undefined;
}

/** The headline is the worst client. A mean of 21 clients hides the one that fails. */
function worstScore(scores: Record<string, { score: number }>): number {
  const values = Object.values(scores);
  if (values.length === 0) return 0;
  return Math.min(...values.map((s) => s.score));
}

/**
 * The language the source is written in.
 *
 * Anything but `html` is compiled before analysis and also selects the syntax
 * the fix snippets are written in.
 */
const formatEnum = z.enum(["html", "jsx", "mjml", "maizzle"]).optional();

/**
 * How much compatibility detail to return.
 *
 * `summary` collapses the engine's per-client, per-selector warnings into one
 * entry per problem listing the clients it affects: the same information at a
 * fraction of the tokens. It also leaves out info findings, counting them
 * instead: they fall back safely, and on a typical email they are 35 of 37
 * entries, which buried the two warnings an agent had to fix. `full` is the
 * engine's own shape, per client, with fix snippets and info, for a caller that
 * wants everything.
 */
const detailEnum = z
  .enum(["summary", "full"])
  .optional()
  .describe(
    "'summary' (default) returns one entry per error or warning, listing the clients it affects, and only counts info findings (safe fallbacks). 'full' returns one entry per client with fix snippets, info included.",
  );

const htmlParam = z
  .string()
  .optional()
  .describe("The email source: HTML, or an MJML / Maizzle / React Email template when `format` says so. Pass this or `path`.");

const pathParam = z
  .string()
  .optional()
  .describe("Absolute path to the email source file (.html, .htm, .mjml, .jsx, .tsx, .vue), instead of `html`. Prefer it when the email is on disk: the source stays out of your context. The extension sets `format` unless you pass one.");

const targetingPolicyEnum = z
  .enum(["progressive", "strict", "lenient"])
  .optional()
  .describe(
    "'progressive' (default) suppresses compatibility false-positives inside client-targeted scopes and only flags deprecated or dangerous hacks. 'strict' treats targeting as non-standard and reports every hack. 'lenient' suppresses false positives and ignores non-fatal targeting warnings.",
  );

const skipEnum = z.enum([
  "spam",
  "links",
  "accessibility",
  "images",
  "compatibility",
  "inboxPreview",
  "size",
  "templateVariables",
  "overflow",
  "visual",
  "darkContrast",
  "mobileContrast",
  "design",
  "vml",
  "styleSurvival",
  "targeting",
]);

const clientsParam = z
  .array(z.string())
  .optional()
  .describe(
    "Only report these client IDs (e.g. ['gmail-web','outlook-windows']). The fastest way to cut the response when you care about specific clients. Use list_clients for the IDs.",
  );

/**
 * Reject a client id the engine does not know.
 *
 * Filtering to a typo would return an empty list, which reads as "this email
 * is fine for that client"; the most misleading answer the tool can give.
 */
function validateClients(clients: string[] | undefined) {
  if (!clients?.length) return undefined;
  const known = new Set(knownClientIds());
  const unknown = clients.filter((c) => !known.has(c));
  if (!unknown.length) return undefined;
  return mcpError(
    `Unknown client ${unknown.length > 1 ? "IDs" : "ID"}: ${unknown.join(", ")}. Call list_clients for the valid IDs.`,
  );
}

/** The compatibility payload, at the requested level of detail. */
function compatibilityPayload(
  warnings: CSSWarning[],
  detail: "summary" | "full" | undefined,
  clients: string[] | undefined,
) {
  const scoped = forClients(warnings, clients);
  if (detail === "full") {
    return {
      warningCount: scoped.length,
      warnings: scoped.map((w) => ({
        client: w.client,
        property: w.property,
        severity: w.severity,
        message: w.message,
        suggestion: w.suggestion,
        fix: w.fix,
        fixType: w.fixType,
        ...withPositions(w),
      })),
    };
  }
  const collapsed = collapseWarnings(scoped);
  const findings = collapsed.filter((f) => f.severity !== "info");
  const info = collapsed.length - findings.length;
  return {
    warningCount: scoped.length,
    findingCount: findings.length,
    findings,
    ...(info ? { infoFindings: info, infoNote: "Safe fallbacks, not problems. Pass detail:'full' to list them." } : {}),
  };
}

/**
 * Do source positions refer to the code the caller handed us?
 *
 * Only for plain HTML. JSX, MJML and Maizzle are compiled before analysis, so a
 * position would point into generated output: worse than none, because an
 * agent would edit the wrong line with confidence.
 */
function positionsApply(format?: string): boolean {
  return (format ?? "html") === "html";
}

/**
 * The position fields a finding carries, when it has them.
 *
 * Deliberately compact: this response is read by a model paying for every
 * token, and a newsletter can produce a thousand occurrences. The first one
 * gets a full position, enough to edit it, and the rest are reduced to line
 * numbers, which is all an assistant needs to go find them. Carrying every
 * occurrence in full nearly doubled the payload on a real fixture.
 */
function withPositions<T extends {
  loc?: SourceLocation;
  locs?: SourceLocation[];
  locsTruncated?: boolean;
}>(w: T) {
  if (!w.loc) return {};
  const { line, column, offset, length } = w.loc;
  const others = (w.locs ?? []).slice(1).map((l) => l.line);
  return {
    loc: { line, column, offset, length },
    ...(others.length ? { alsoAtLines: others } : {}),
    ...(w.locsTruncated ? { locsTruncated: true } : {}),
  };
}

function validateHtmlSize(html: string) {
  if (html.length > MAX_HTML_SIZE) {
    return mcpError(`HTML input exceeds ${Math.round(MAX_HTML_SIZE / 1024)}KB limit. Reduce the email size and try again.`);
  }
  return null;
}

const server = new McpServer({
  name: "emailens",
  version: "0.13.1",
});

// ── Local Tool: preview_email ──────────────────────────────────────

server.registerTool(
  "preview_email",
  {
    title: "Preview Email",
    description:
      `Full email compatibility preview, transforms HTML for ${EMAIL_CLIENTS.length} email clients (Gmail, Outlook, Apple Mail, Yahoo, Samsung, Thunderbird, HEY, Proton Mail, AOL, Fastmail, Superhuman), analyzes CSS, generates scores, simulates dark mode, checks inbox preview and email size.`,
    inputSchema: {
      html: htmlParam,
      path: pathParam,
      clients: z
        .array(z.string())
        .optional()
        .describe("Optional client ID filter (e.g. ['gmail-web', 'outlook-windows'])"),
      format: formatEnum.describe("Source format: 'html' (default), 'jsx' (React Email), 'mjml', or 'maizzle' (HTML template or Vue single-file component). Anything but 'html' is compiled before analysis and sets the syntax of the fix snippets. A pasted Vue file with no format is compiled as maizzle."),
      targetingPolicy: targetingPolicyEnum,
    },
    annotations: {
      title: "Preview Email",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ html: inline, path, clients, format: given, targetingPolicy }) => {
    const input = await readSource(inline, path, given);
    if (!input.ok) return mcpError(input.message);
    const { html, format } = input;
    const sizeError = validateHtmlSize(html);
    if (sizeError) return sizeError;

    const source = await toHtml(html, format);
    if (!source.ok) return mcpError(source.message);

    const validClientIds = new Set(EMAIL_CLIENTS.map((c) => c.id));
    const framework = toFramework(resolveSourceFormat(html, format));
    const session = createSession(source.html, { framework, targetingPolicy });

    let transforms;
    if (clients) {
      const filter = clients.filter((c) => validClientIds.has(c));
      if (filter.length === 0) {
        return mcpError(
          JSON.stringify({ error: "No valid client IDs provided", validClientIds: Array.from(validClientIds) }),
        );
      }
      transforms = filter.map((c) => transformForClient(source.html, c, framework));
    } else {
      transforms = transformForAllClients(source.html, framework);
    }

    const warnings = session.analyze();
    const scores = generateCompatibilityScore(warnings);
    const inboxPreview = session.extractInboxPreview();
    const sizeReport = session.checkSize();

    const darkMode: Record<string, { html: string; warnings: CSSWarning[] }> = {};
    for (const t of transforms) {
      darkMode[t.clientId] = simulateDarkMode(source.html, t.clientId);
    }

    const overallScore = worstScore(scores);

    const plainText = toPlainText(source.html);

    const result: Record<string, unknown> = {
      overallScore,
      compatibilityScores: scores,
      cssWarnings: warnings.map((w) => ({
        client: w.client,
        property: w.property,
        severity: w.severity,
        message: w.message,
        suggestion: w.suggestion,
        fix: w.fix,
        fixType: w.fixType,
      })),
      inboxPreview,
      sizeReport,
      ...(plainText ? { plainText } : {}),
      clientCount: transforms.length,
      darkModeWarnings: Object.entries(darkMode).reduce(
        (acc, [clientId, dm]) => {
          if (dm.warnings.length > 0) acc[clientId] = dm.warnings.length;
          return acc;
        },
        {} as Record<string, number>,
      ),
    };

    // Contextual tip when no API key: the fix route on issues, and on a clean
    // result the name of who checked it, so success is attributable too.
    if (!config.isHosted) {
      result.tip = overallScore < 90
        ? "Capture real screenshots to verify these issues across clients. Add EMAILENS_API_KEY to your MCP config \u2192 app.emailens.dev/dashboard/api?utm_source=mcp"
        : "Checked by Emailens against 21 email clients. Confirm on real Outlook, Gmail and Apple Mail \u2192 emailens.dev/real-devices?utm_source=mcp";
    }

    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  },
);

// ── Local Tool: analyze_email (CSS-only, reverted from audit) ──────

server.registerTool(
  "analyze_email",
  {
    title: "Analyze Email",
    description:
      "Fix error and warning findings. Info findings are not problems (the email falls back safely there): never remove responsive (@media) or dark-mode CSS to clear them. Quick CSS compatibility analysis, returns per-client scores and one finding per problem, listing the clients it affects. For HTML input each finding carries loc (line, column, offset) and alsoAtLines, so you can edit the exact source. Narrow with clients, or pass detail:'full' for the per-client breakdown with fix snippets. Use audit_email for a full quality report (spam, links, a11y, images, etc.).",
    inputSchema: {
      html: htmlParam,
      path: pathParam,
      format: formatEnum.describe("Source format: 'html' (default), 'jsx' (React Email), 'mjml', or 'maizzle' (HTML template or Vue single-file component). Anything but 'html' is compiled before analysis and sets the syntax of the fix snippets. A pasted Vue file with no format is compiled as maizzle."),
      detail: detailEnum,
      clients: clientsParam,
      targetingPolicy: targetingPolicyEnum,
    },
    annotations: {
      title: "Analyze Email",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ html: inline, path, format: given, detail, clients, targetingPolicy }) => {
    const input = await readSource(inline, path, given);
    if (!input.ok) return mcpError(input.message);
    const { html, format } = input;
    const sizeError = validateHtmlSize(html);
    if (sizeError) return sizeError;
    const clientError = validateClients(clients);
    if (clientError) return clientError;

    const source = await toHtml(html, format);
    if (!source.ok) return mcpError(source.message);

    const warnings = analyzeEmail(source.html, toFramework(resolveSourceFormat(html, format)), {
      positions: positionsApply(resolveSourceFormat(html, format)),
      targetingPolicy,
    });
    // Scores stay whole-email: filtering to two clients should narrow what is
    // reported, not silently change what the email scores.
    const scores = generateCompatibilityScore(warnings);

    const overallScore = worstScore(scores);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              overallScore,
              scores,
              ...compatibilityPayload(warnings, detail, clients),
            }),
        },
      ],
    };
  },
);

// ── Local Tool: audit_email ────────────────────────────────────────

server.registerTool(
  "audit_email",
  {
    title: "Audit Email",
    description:
      "Fix error and warning findings, and restore anything listed in designRemovals. Info findings are not problems (the email falls back safely there): never remove responsive (@media), dark-mode CSS or rounded corners to clear them. designRemovals compares this version with the first one audited for the same email (or with previousHtml): design the edits deleted, such as @media rules, dark mode, corners, gradients, VML fallbacks or images. Comprehensive email quality audit: CSS compatibility, spam scoring, link validation, accessibility, images, inbox preview, size (Gmail clipping), template variables, content overflow, visual fallbacks, dark-mode and mobile text contrast, design consistency, structural faults in Outlook-only VML (which lives inside conditional comments and is invisible to every other check), style survival: CSS a client parses correctly and then discards, such as a stylesheet past Gmail's 16 KB ceiling or every rule after a `}}`, which no support matrix can express, and client targeting: HowToTarget hacks such as Gmail u+.body or MSO conditionals, which do not score as css-hack. For HTML input, findings tied to a specific element carry loc (line, column, offset) so you can edit the exact source. Compatibility is collapsed to one finding per problem listing the clients it affects; pass detail:'full' for the per-client breakdown with fix snippets. Use skip to omit checks, targetingPolicy to change how targeted scopes affect scores, and clients to narrow which clients are reported.",
    inputSchema: {
      html: htmlParam,
      path: pathParam,
      format: formatEnum.describe("Source format: 'html' (default), 'jsx' (React Email), 'mjml', or 'maizzle' (HTML template or Vue single-file component). Anything but 'html' is compiled before analysis and sets the syntax of the fix snippets. A pasted Vue file with no format is compiled as maizzle."),
      skip: z
        .array(skipEnum)
        .optional()
        .describe("Checks to skip (e.g. ['spam', 'images'])"),
      detail: detailEnum,
      clients: clientsParam,
      targetingPolicy: targetingPolicyEnum,
      emailType: z
        .enum(["marketing", "transactional"])
        .optional()
        .describe("'transactional' (receipts, password resets, codes, alerts: no unsubscribe link required) or 'marketing'. Omitted: guessed from the content, which misses many transactional emails."),
      previousHtml: z
        .string()
        .optional()
        .describe("The design to hold this version to, usually your first draft. Omitted: the first version of this email audited in this session (matched by <title> and text)."),
    },
    annotations: {
      title: "Audit Email",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ html: inline, path, format: given, skip, detail, clients, targetingPolicy, emailType, previousHtml }) => {
    const input = await readSource(inline, path, given);
    if (!input.ok) return mcpError(input.message);
    const { html, format } = input;
    const sizeError = validateHtmlSize(html);
    if (sizeError) return sizeError;
    const clientError = validateClients(clients);
    if (clientError) return clientError;

    const source = await toHtml(html, format);
    if (!source.ok) return mcpError(source.message);

    const session = createSession(source.html, {
      framework: toFramework(resolveSourceFormat(html, format)),
      positions: positionsApply(resolveSourceFormat(html, format)),
      targetingPolicy,
    });
    const report = session.audit({ skip, ...(emailType ? { spam: { emailType } } : {}) });

    const overallCompatibility = worstScore(report.compatibility.scores);
    const baseline = previousHtml ? (await toHtml(previousHtml, format)) : { ok: true as const, html: firstDraft(source.html) };
    const designRemovals = baseline.ok ? checkDesignRetention(baseline.html, source.html) : [];

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              overallCompatibility,
              designRemovals,
              compatibility: {
                scores: report.compatibility.scores,
                ...compatibilityPayload(report.compatibility.warnings, detail, clients),
              },
              spam: report.spam,
              links: report.links,
              accessibility: report.accessibility,
              images: report.images,
              inboxPreview: report.inboxPreview,
              size: report.size,
              templateVariables: report.templateVariables,
              overflow: report.overflow,
              visual: report.visual,
              vml: report.vml,
              darkContrast: report.darkContrast,
              mobileContrast: report.mobileContrast,
              design: report.design,
              styleSurvival: report.styleSurvival,
              targeting: report.targeting,
            }),
        },
      ],
    };
  },
);

// ── Local Tool: fix_email ──────────────────────────────────────────

server.registerTool(
  "fix_email",
  {
    title: "Fix Email",
    description:
      "Generate a structured fix prompt for email compatibility issues. Returns markdown with the original code, detected issues (CSS or structural), fix snippets, and format-specific instructions. Use after preview_email or analyze_email.",
    inputSchema: {
      html: htmlParam,
      path: pathParam,
      format: formatEnum.describe("Source format: 'html' (default), 'jsx' (React Email), 'mjml', or 'maizzle' (HTML template or Vue single-file component). Anything but 'html' is compiled before analysis and sets the syntax of the fix snippets. A pasted Vue file with no format is compiled as maizzle."),
      scope: z.enum(["all", "current"]).optional().describe("'all' (default) or 'current' (requires selectedClientId)"),
      selectedClientId: z.string().optional().describe("Client ID to scope fixes to (e.g. 'outlook-windows')"),
    },
    annotations: {
      title: "Fix Email",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ html: inline, path, format: given, scope, selectedClientId }) => {
    const input = await readSource(inline, path, given);
    if (!input.ok) return mcpError(input.message);
    const { html, format } = input;
    const sizeError = validateHtmlSize(html);
    if (sizeError) return sizeError;

    // The findings come from the compiled output, because that is what a
    // client renders. The prompt keeps the caller's own source, because that is
    // the file they will edit; a fix written against generated HTML is not a
    // fix they can apply.
    const source = await toHtml(html, format);
    if (!source.ok) return mcpError(source.message);

    const resolved = resolveSourceFormat(html, format) as
      | "html"
      | "jsx"
      | "mjml"
      | "maizzle";
    const framework = toFramework(resolved);
    const fixScope = scope === "current" ? "current" : "all";
    const inputFormat = resolved;

    const warnings = analyzeEmail(source.html, framework);
    const scores = generateCompatibilityScore(warnings);

    if (warnings.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ message: "No compatibility issues found \u2014 nothing to fix.", overallScore: 100 }),
          },
        ],
      };
    }

    const estimate = await estimateAiFixTokens({
      originalHtml: html,
      warnings,
      scores,
      scope: fixScope,
      selectedClientId,
      format: inputFormat,
    });

    const prompt = generateFixPrompt({
      originalHtml: html,
      warnings,
      scores,
      scope: fixScope,
      selectedClientId,
      format: inputFormat,
    });

    const structural = warnings.filter((w) => w.fixType === "structural");

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              totalWarnings: warnings.length,
              structuralWarnings: structural.length,
              cssWarnings: warnings.length - structural.length,
              tokenEstimate: {
                inputTokens: estimate.inputTokens,
                estimatedOutputTokens: estimate.estimatedOutputTokens,
                truncated: estimate.truncated,
              },
              note: "Apply the fixes in the prompt below. Structural issues require HTML restructuring (tables, VML conditionals), not just CSS changes.",
            }),
        },
        { type: "text" as const, text: input.path ? withoutSource(prompt, html, inputFormat, input.path) : prompt },
      ],
    };
  },
);

// ── Local Tool: list_clients ───────────────────────────────────────

server.registerTool(
  "list_clients",
  {
    title: "List Email Clients",
    description: "List every supported email client with IDs, names, engines, and dark mode support.",
    annotations: {
      title: "List Email Clients",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            EMAIL_CLIENTS.map((c) => ({
              id: c.id,
              name: c.name,
              category: c.category,
              engine: c.engine,
              darkModeSupport: c.darkModeSupport,
              ...(c.deprecated ? { deprecated: c.deprecated } : {}),
            }))),
        },
      ],
    };
  },
);

// ── Local Tool: diff_emails ────────────────────────────────────────

server.registerTool(
  "diff_emails",
  {
    title: "Diff Emails",
    description:
      "Compare two email HTML versions, shows score changes, fixed issues, and newly introduced issues per client. Use after making fixes to verify improvements.",
    inputSchema: {
      before: z.string().optional().describe("Original email source. Pass this or `beforePath`."),
      after: z.string().optional().describe("Modified email source, in the same format. Pass this or `afterPath`."),
      beforePath: z.string().optional().describe("Absolute path to the original source file, instead of `before`"),
      afterPath: z.string().optional().describe("Absolute path to the modified source file, instead of `after`"),
      format: formatEnum.describe("Source format: 'html' (default), 'jsx' (React Email), 'mjml', or 'maizzle' (HTML template or Vue single-file component). Anything but 'html' is compiled before analysis and sets the syntax of the fix snippets. A pasted Vue file with no format is compiled as maizzle."),
    },
    annotations: {
      title: "Diff Emails",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ before: beforeInline, after: afterInline, beforePath, afterPath, format: given }) => {
    const beforeInput = await readSource(beforeInline, beforePath, given, { html: "before", path: "beforePath" });
    if (!beforeInput.ok) return mcpError(beforeInput.message);
    const afterInput = await readSource(afterInline, afterPath, given, { html: "after", path: "afterPath" });
    if (!afterInput.ok) return mcpError(afterInput.message);
    const before = beforeInput.html;
    const after = afterInput.html;
    const format = afterInput.format ?? beforeInput.format;
    const beforeSizeError = validateHtmlSize(before);
    if (beforeSizeError) return beforeSizeError;
    const afterSizeError = validateHtmlSize(after);
    if (afterSizeError) return afterSizeError;

    const beforeSource = await toHtml(before, format);
    if (!beforeSource.ok) return mcpError(beforeSource.message);
    const afterSource = await toHtml(after, format);
    if (!afterSource.ok) return mcpError(afterSource.message);

    const framework = toFramework(
      resolveSourceFormat(before, format) === "maizzle" ||
        resolveSourceFormat(after, format) === "maizzle"
        ? (format ?? "maizzle")
        : (format ?? "html"),
    );

    const beforeWarnings = analyzeEmail(beforeSource.html, framework);
    const beforeScores = generateCompatibilityScore(beforeWarnings);

    const afterWarnings = analyzeEmail(afterSource.html, framework);
    const afterScores = generateCompatibilityScore(afterWarnings);

    const results = diffResults(
      { scores: beforeScores, warnings: beforeWarnings },
      { scores: afterScores, warnings: afterWarnings },
    );

    let clientsImproved = 0;
    let clientsRegressed = 0;
    let clientsUnchanged = 0;
    let totalDelta = 0;

    const mappedResults = results.map((r) => {
      if (r.scoreDelta > 0) clientsImproved++;
      else if (r.scoreDelta < 0) clientsRegressed++;
      else clientsUnchanged++;
      totalDelta += r.scoreDelta;

      return {
        clientId: r.clientId,
        scoreBefore: r.scoreBefore,
        scoreAfter: r.scoreAfter,
        scoreDelta: r.scoreDelta,
        fixed: r.fixed.map((w) => ({ property: w.property, client: w.client, message: w.message })),
        introduced: r.introduced.map((w) => ({ property: w.property, client: w.client, message: w.message })),
        unchanged: r.unchanged.length,
      };
    });

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              results: mappedResults,
              summary: {
                clientsImproved,
                clientsRegressed,
                clientsUnchanged,
                avgScoreDelta: results.length > 0 ? Math.round((totalDelta / results.length) * 10) / 10 : 0,
              },
            }),
        },
      ],
    };
  },
);

// ── Local Tool: check_deliverability ───────────────────────────────

server.registerTool(
  "check_deliverability",
  {
    title: "Check Deliverability",
    description:
      "Check email deliverability for a domain: SPF, DKIM, DMARC, MX, and BIMI records. Returns a score (0-100) and actionable issues. Uses DNS lookups (no API key needed).",
    inputSchema: {
      domain: z
        .string()
        .min(3)
        .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i, "Invalid domain format")
        .describe("Domain to check (e.g. 'company.com')"),
    },
    annotations: {
      title: "Check Deliverability",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ domain }) => {
    try {
      if (!_checkDeliverability) {
        const mod = await import("@emailens/engine/server");
        _checkDeliverability = mod.checkDeliverability;
      }
      const report = await _checkDeliverability!(domain);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(report) }],
      };
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      if (msg.includes("Cannot find") || msg.includes("cannot find") || msg.includes("MODULE_NOT_FOUND")) {
        return mcpError(
          "check_deliverability requires @emailens/engine >=0.9.1 with the /server subpath. Update with: npm install @emailens/engine@latest",
        );
      }
      return mcpError(`Deliverability check failed for "${domain}": ${msg}`);
    }
  },
);

// ── Hosted Tool: capture_screenshots ───────────────────────────────

server.registerTool(
  "capture_screenshots",
  {
    title: "Capture Screenshots",
    description:
      "Capture real email screenshots across 21 clients (Gmail, Outlook, Apple Mail, etc.) with light and dark mode variants. Screenshots are rendered in real browsers and hosted on CDN. Requires EMAILENS_API_KEY env var \u2014 free plan at emailens.dev?utm_source=mcp.",
    inputSchema: {
      html: htmlParam,
      path: pathParam,
      format: formatEnum.describe("Input format"),
      clients: z.array(z.string()).optional().describe("Filter to specific client IDs"),
      modes: z
        .array(z.enum(["light", "dark"]))
        .optional()
        .describe("Screenshot modes (default: ['light'])"),
      title: z.string().optional().describe("Name for the hosted preview"),
    },
    annotations: {
      title: "Capture Screenshots",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ html: inline, path, format: given, clients, modes, title }) => {
    const input = await readSource(inline, path, given);
    if (!input.ok) return mcpError(input.message);
    const { html, format } = input;
    if (!config.isHosted) {
      return noApiKeyError("capture_screenshots");
    }

    const opts = { apiKey: config.apiKey!, apiUrl: config.apiUrl };

    // Step 1: Create hosted preview
    const previewResult = await apiRequest<{
      id: string;
      overallScore: number;
    }>("/api/preview", {
      ...opts,
      body: { html, format, clients, title, source: "mcp" },
      timeoutMs: 30_000,
    });

    if (previewResult.isError) {
      return mcpError(previewResult.error!);
    }

    const previewId = previewResult.data!.id;

    // Step 2: Capture screenshots (with one retry on timeout)
    let screenshotResult = await apiRequest<{
      screenshots: Record<string, string>;
      screenshotStatus: string;
      captured: string[];
      failed: string[];
    }>(`/api/preview/${previewId}/screenshots`, {
      ...opts,
      body: { clients, modes },
      timeoutMs: 120_000,
    });

    // Retry once on timeout
    if (screenshotResult.isError && screenshotResult.error?.includes("timed out")) {
      screenshotResult = await apiRequest(`/api/preview/${previewId}/screenshots`, {
        ...opts,
        body: { clients, modes },
        timeoutMs: 120_000,
      });
    }

    // If screenshots still failed, return preview analysis with error note
    if (screenshotResult.isError) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                previewId,
                previewUrl: `${config.apiUrl}/preview/${previewId}`,
                overallScore: previewResult.data!.overallScore,
                screenshots: {},
                screenshotStatus: "failed",
                captured: [],
                failed: [],
                note: `Preview created but screenshot capture failed: ${screenshotResult.error}. View the full preview at the URL above.`,
              }),
          },
        ],
      };
    }

    const ss = screenshotResult.data!;
    const result: Record<string, unknown> = {
      previewId,
      previewUrl: `${config.apiUrl}/preview/${previewId}`,
      overallScore: previewResult.data!.overallScore,
      screenshots: ss.screenshots,
      screenshotStatus: ss.screenshotStatus,
      captured: ss.captured,
      failed: ss.failed,
    };

    if (ss.failed?.length > 0) {
      result.note = `${ss.failed.length} of ${(ss.captured?.length ?? 0) + ss.failed.length} screenshots failed: ${ss.failed.join(", ")}`;
    }

    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  },
);

// ── Hosted Tool: share_preview ─────────────────────────────────────

server.registerTool(
  "share_preview",
  {
    title: "Share Preview",
    description:
      "Create a shareable link for an email preview. Recipients see the full analysis without needing an account. Requires EMAILENS_API_KEY env var and Dev plan ($9/mo).",
    inputSchema: {
      html: htmlParam,
      path: pathParam,
      title: z.string().optional().describe("Display title for the share page"),
      format: formatEnum.describe("Input format"),
    },
    annotations: {
      title: "Share Preview",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ html: inline, path, title, format: given }) => {
    const input = await readSource(inline, path, given);
    if (!input.ok) return mcpError(input.message);
    const { html, format } = input;
    if (!config.isHosted) {
      return noApiKeyError("share_preview", "Shareable links require the Dev plan ($9/mo).");
    }

    const result = await apiRequest<{ id: string; expiresAt: string | null }>("/api/share", {
      apiKey: config.apiKey!,
      apiUrl: config.apiUrl,
      body: { html, title, format },
    });

    if (result.isError) {
      return mcpError(result.error!);
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              shareUrl: `${config.apiUrl}/share/${result.data!.id}`,
              expiresAt: result.data!.expiresAt,
            }),
        },
      ],
    };
  },
);

// ── Hosted Tool: sandbox_get_inbox ──────────────────────────────────

server.registerTool(
  "sandbox_get_inbox",
  {
    title: "Get Sandbox Inbox",
    description:
      "Get your active Emailens sandbox test address (or create a new one). Send emails here via SMTP (smtp.emailens.dev:2525) or inbound domain routing. Requires EMAILENS_API_KEY.",
    inputSchema: {
      name: z.string().optional().describe("Optional inbox name (e.g. 'Auth E2E Test')"),
    },
    annotations: {
      title: "Get Sandbox Inbox",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ name }) => {
    if (!config.isHosted) {
      return noApiKeyError("sandbox_get_inbox", "Email sandboxing requires an Emailens account and API key.");
    }

    const result = await apiRequest<{
      inbox?: { id: string; name: string; createdAt: string; lastReceivedAt: string | null };
      address?: string;
    }>("/api/sandbox/v1/inbox", {
      apiKey: config.apiKey!,
      apiUrl: config.apiUrl,
    });

    if (result.isError) {
      return mcpError(result.error!);
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result.data),
        },
      ],
    };
  },
);

// ── Hosted Tool: sandbox_wait_for_email ─────────────────────────────

server.registerTool(
  "sandbox_wait_for_email",
  {
    title: "Wait for Sandbox Email",
    description:
      "Poll and wait for a matching incoming test email in the sandbox. Automatically extracts 4-8 digit OTP codes and action links for zero-regex test assertions. Requires EMAILENS_API_KEY.",
    inputSchema: {
      inboxId: z.string().optional().describe("Optional inbox ID filter"),
      subject: z.string().optional().describe("Substring match for email subject (case-insensitive)"),
      sender: z.string().optional().describe("Substring match for sender address (case-insensitive)"),
      timeoutSeconds: z.number().optional().describe("Max seconds to wait (default: 30, max: 60)"),
    },
    annotations: {
      title: "Wait for Sandbox Email",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ inboxId, subject, sender, timeoutSeconds = 30 }) => {
    if (!config.isHosted) {
      return noApiKeyError("sandbox_wait_for_email", "Email sandboxing requires an Emailens account and API key.");
    }

    const params = new URLSearchParams();
    if (inboxId) params.set("inboxId", inboxId);
    if (subject) params.set("subject", subject);
    if (sender) params.set("sender", sender);
    params.set("timeout", String(timeoutSeconds));

    const result = await apiRequest<{
      message: {
        id: string;
        subject: string;
        sender: string;
        otp?: string | null;
        actionUrl?: string | null;
        links?: Array<{ href: string; text?: string }>;
        receivedAt: string;
      };
    }>(`/api/sandbox/v1/messages/wait?${params.toString()}`, {
      apiKey: config.apiKey!,
      apiUrl: config.apiUrl,
      timeoutMs: (timeoutSeconds + 5) * 1000,
    });

    if (result.isError) {
      return mcpError(result.error!);
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result.data?.message ?? result.data),
        },
      ],
    };
  },
);

// ── Hosted Tool: sandbox_list_messages ──────────────────────────────

server.registerTool(
  "sandbox_list_messages",
  {
    title: "List Sandbox Messages",
    description:
      "List recently received test emails in your sandbox inboxes. Requires EMAILENS_API_KEY.",
    inputSchema: {
      inboxId: z.string().optional().describe("Optional inbox ID filter"),
    },
    annotations: {
      title: "List Sandbox Messages",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ inboxId }) => {
    if (!config.isHosted) {
      return noApiKeyError("sandbox_list_messages", "Email sandboxing requires an Emailens account and API key.");
    }

    const params = inboxId ? `?inboxId=${encodeURIComponent(inboxId)}` : "";
    const result = await apiRequest<{ messages: unknown[] }>(`/api/sandbox/messages${params}`, {
      apiKey: config.apiKey!,
      apiUrl: config.apiUrl,
    });

    if (result.isError) {
      return mcpError(result.error!);
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result.data),
        },
      ],
    };
  },
);

// ── Hosted Tool: sandbox_get_message ────────────────────────────────

server.registerTool(
  "sandbox_get_message",
  {
    title: "Get Sandbox Message",
    description:
      "Get complete captured email details including HTML/text parts, extracted OTP, magic links, headers, and spam analysis. Requires EMAILENS_API_KEY.",
    inputSchema: {
      messageId: z.string().describe("ID of the sandbox message"),
    },
    annotations: {
      title: "Get Sandbox Message",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ messageId }) => {
    if (!config.isHosted) {
      return noApiKeyError("sandbox_get_message", "Email sandboxing requires an Emailens account and API key.");
    }

    const result = await apiRequest<{ message: unknown }>(`/api/sandbox/messages/${encodeURIComponent(messageId)}`, {
      apiKey: config.apiKey!,
      apiUrl: config.apiUrl,
    });

    if (result.isError) {
      return mcpError(result.error!);
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result.data),
        },
      ],
    };
  },
);

// ── Start ────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
