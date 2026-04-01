import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createSession,
  analyzeEmail,
  generateCompatibilityScore,
  generateFixPrompt,
  estimateAiFixTokens,
  structuralWarnings,
  diffResults,
  toPlainText,
  EMAIL_CLIENTS,
  MAX_HTML_SIZE,
  type Framework,
  type CSSWarning,
} from "@emailens/engine";
// Lazy-imported: @emailens/engine/server may not exist in all engine versions
let _checkDeliverability: ((domain: string) => Promise<unknown>) | null = null;
import { config } from "./config.js";
import { apiRequest, mcpError, noApiKeyError } from "./hosted.js";

function toFramework(format?: string): Framework | undefined {
  if (format === "jsx" || format === "mjml" || format === "maizzle") return format;
  return undefined;
}

const formatEnum = z.enum(["html", "jsx", "mjml", "maizzle"]).optional();

function validateHtmlSize(html: string) {
  if (html.length > MAX_HTML_SIZE) {
    return mcpError(`HTML input exceeds ${Math.round(MAX_HTML_SIZE / 1024)}KB limit. Reduce the email size and try again.`);
  }
  return null;
}

const server = new McpServer({
  name: "emailens",
  version: "0.4.0",
});

// ── Local Tool: preview_email ──────────────────────────────────────

server.registerTool(
  "preview_email",
  {
    title: "Preview Email",
    description:
      "Full email compatibility preview — transforms HTML for 15 email clients (Gmail, Outlook, Apple Mail, Yahoo, Samsung, Thunderbird, HEY, Superhuman), analyzes CSS, generates scores, simulates dark mode, checks inbox preview and email size.",
    inputSchema: {
      html: z.string().describe("The email HTML source code"),
      clients: z
        .array(z.string())
        .optional()
        .describe("Optional client ID filter (e.g. ['gmail-web', 'outlook-windows'])"),
      format: formatEnum.describe("Input format: 'html' (default), 'jsx', 'mjml', or 'maizzle'"),
    },
    annotations: {
      title: "Preview Email",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ html, clients, format }) => {
    const sizeError = validateHtmlSize(html);
    if (sizeError) return sizeError;

    const validClientIds = new Set(EMAIL_CLIENTS.map((c) => c.id));
    const framework = toFramework(format);
    const session = createSession(html, { framework });

    let transforms;
    if (clients) {
      const filter = clients.filter((c) => validClientIds.has(c));
      if (filter.length === 0) {
        return mcpError(
          JSON.stringify({ error: "No valid client IDs provided", validClientIds: Array.from(validClientIds) }, null, 2),
        );
      }
      transforms = filter.map((c) => session.transformForClient(c));
    } else {
      transforms = session.transformForAllClients();
    }

    const warnings = session.analyze();
    const scores = session.score(warnings);
    const inboxPreview = session.extractInboxPreview();
    const sizeReport = session.checkSize();

    const darkMode: Record<string, { html: string; warnings: CSSWarning[] }> = {};
    for (const t of transforms) {
      darkMode[t.clientId] = session.simulateDarkMode(t.clientId);
    }

    const scoreValues = Object.values(scores);
    const overallScore =
      scoreValues.length > 0
        ? Math.round(scoreValues.reduce((a, b) => a + b.score, 0) / scoreValues.length)
        : 0;

    const plainText = toPlainText(html);

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

    // Contextual tip: only when no API key and score indicates issues
    if (!config.isHosted && overallScore < 90) {
      result.tip =
        "Capture real screenshots to verify these issues across clients. Add EMAILENS_API_KEY to your MCP config \u2192 emailens.dev/settings/api-keys?ref=mcp";
    }

    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  },
);

// ── Local Tool: analyze_email (CSS-only, reverted from audit) ──────

server.registerTool(
  "analyze_email",
  {
    title: "Analyze Email",
    description:
      "Quick CSS compatibility analysis — returns warnings and per-client scores. Use audit_email for full quality report (spam, links, a11y, images, etc.).",
    inputSchema: {
      html: z.string().describe("The email HTML source code"),
      format: formatEnum.describe("Input format for framework-specific fix snippets"),
    },
    annotations: {
      title: "Analyze Email",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ html, format }) => {
    const sizeError = validateHtmlSize(html);
    if (sizeError) return sizeError;

    const warnings = analyzeEmail(html, toFramework(format));
    const scores = generateCompatibilityScore(warnings);

    const scoreValues = Object.values(scores);
    const overallScore =
      scoreValues.length > 0
        ? Math.round(scoreValues.reduce((a, b) => a + b.score, 0) / scoreValues.length)
        : 0;

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              overallScore,
              scores,
              warningCount: warnings.length,
              warnings: warnings.map((w) => ({
                client: w.client,
                property: w.property,
                severity: w.severity,
                message: w.message,
                suggestion: w.suggestion,
                fix: w.fix,
                fixType: w.fixType,
              })),
            },
            null,
            2,
          ),
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
      "Comprehensive email quality audit — CSS compatibility, spam scoring, link validation, accessibility, images, inbox preview, size (Gmail clipping), and template variables. Use skip to omit specific checks.",
    inputSchema: {
      html: z.string().describe("The email HTML source code"),
      format: formatEnum.describe("Input format for framework-specific fix snippets"),
      skip: z
        .array(z.enum(["spam", "links", "accessibility", "images", "compatibility", "inboxPreview", "size", "templateVariables"]))
        .optional()
        .describe("Checks to skip (e.g. ['spam', 'images'])"),
    },
    annotations: {
      title: "Audit Email",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ html, format, skip }) => {
    const sizeError = validateHtmlSize(html);
    if (sizeError) return sizeError;

    const session = createSession(html, { framework: toFramework(format) });
    const report = session.audit({ skip });

    const scoreValues = Object.values(report.compatibility.scores);
    const overallCompatibility =
      scoreValues.length > 0
        ? Math.round(scoreValues.reduce((a, b) => a + b.score, 0) / scoreValues.length)
        : 0;

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              overallCompatibility,
              compatibility: {
                scores: report.compatibility.scores,
                warningCount: report.compatibility.warnings.length,
                warnings: report.compatibility.warnings.map((w) => ({
                  client: w.client,
                  property: w.property,
                  severity: w.severity,
                  message: w.message,
                  suggestion: w.suggestion,
                  fix: w.fix,
                  fixType: w.fixType,
                })),
              },
              spam: report.spam,
              links: report.links,
              accessibility: report.accessibility,
              images: report.images,
              inboxPreview: report.inboxPreview,
              size: report.size,
              templateVariables: report.templateVariables,
            },
            null,
            2,
          ),
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
      html: z.string().describe("The email HTML source code to fix"),
      format: formatEnum.describe("Input format — controls fix syntax"),
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
  async ({ html, format, scope, selectedClientId }) => {
    const sizeError = validateHtmlSize(html);
    if (sizeError) return sizeError;

    const framework = toFramework(format);
    const fixScope = scope === "current" ? "current" : "all";
    const inputFormat = format || "html";

    const warnings = analyzeEmail(html, framework);
    const scores = generateCompatibilityScore(warnings);

    if (warnings.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ message: "No compatibility issues found \u2014 nothing to fix.", overallScore: 100 }, null, 2),
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

    const structural = structuralWarnings(warnings);

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
            },
            null,
            2,
          ),
        },
        { type: "text" as const, text: prompt },
      ],
    };
  },
);

// ── Local Tool: list_clients ───────────────────────────────────────

server.registerTool(
  "list_clients",
  {
    title: "List Email Clients",
    description: "List all 15 supported email clients with IDs, names, engines, and dark mode support.",
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
            })),
            null,
            2,
          ),
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
      "Compare two email HTML versions — shows score changes, fixed issues, and newly introduced issues per client. Use after making fixes to verify improvements.",
    inputSchema: {
      before: z.string().describe("Original email HTML"),
      after: z.string().describe("Modified email HTML"),
      format: formatEnum.describe("Input format for framework-specific analysis"),
    },
    annotations: {
      title: "Diff Emails",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ before, after, format }) => {
    const beforeSizeError = validateHtmlSize(before);
    if (beforeSizeError) return beforeSizeError;
    const afterSizeError = validateHtmlSize(after);
    if (afterSizeError) return afterSizeError;

    const framework = toFramework(format);

    const beforeWarnings = analyzeEmail(before, framework);
    const beforeScores = generateCompatibilityScore(beforeWarnings);

    const afterWarnings = analyzeEmail(after, framework);
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
            },
            null,
            2,
          ),
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
      "Check email deliverability for a domain — SPF, DKIM, DMARC, MX, and BIMI records. Returns a score (0-100) and actionable issues. Uses DNS lookups (no API key needed).",
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
        content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }],
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
      "Capture real email screenshots across 15 clients (Gmail, Outlook, Apple Mail, etc.) with light and dark mode variants. Screenshots are rendered in real browsers and hosted on CDN. Requires EMAILENS_API_KEY env var \u2014 free plan at emailens.dev?ref=mcp.",
    inputSchema: {
      html: z.string().describe("The email HTML source code"),
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
  async ({ html, format, clients, modes, title }) => {
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
      body: { html, format, clients, title },
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
              },
              null,
              2,
            ),
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

    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
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
      html: z.string().describe("The email HTML source code"),
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
  async ({ html, title, format }) => {
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
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// ── Start ────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
