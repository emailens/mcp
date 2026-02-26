#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  transformForAllClients,
  analyzeEmail,
  generateCompatibilityScore,
  simulateDarkMode,
  generateFixPrompt,
  estimateAiFixTokens,
  EMAIL_CLIENTS,
  type Framework,
  type CSSWarning,
} from "@emailens/engine";

function toFramework(format?: string): Framework | undefined {
  if (format === "jsx" || format === "mjml" || format === "maizzle") return format;
  return undefined;
}

const server = new McpServer({
  name: "emailens",
  version: "0.2.0",
});

// ── Tool: preview_email ─────────────────────────────────────────
server.registerTool(
  "preview_email",
  {
    title: "Preview Email",
    description:
      "Analyze an HTML email and see how it renders across 12 email clients (Gmail, Outlook, Apple Mail, Yahoo, Samsung, Thunderbird, HEY, Superhuman). Returns CSS transforms, compatibility warnings with fix snippets, dark mode simulation, and per-client scores.",
    inputSchema: {
      html: z.string().describe("The email HTML source code"),
      clients: z
        .array(z.string())
        .optional()
        .describe(
          "Optional array of client IDs to filter (e.g. ['gmail-web', 'outlook-windows']). Omit for all clients."
        ),
      format: z
        .enum(["html", "jsx", "mjml", "maizzle"])
        .optional()
        .describe(
          "Input format of the email source: 'html' (default), 'jsx' (React Email), 'mjml', or 'maizzle'. Controls which framework-specific fix snippets appear in the warnings."
        ),
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
    const validClientIds = new Set(EMAIL_CLIENTS.map((c: { id: string }) => c.id));

    let transforms = transformForAllClients(html);
    if (clients) {
      const filter = clients.filter((c: string) => validClientIds.has(c));
      if (filter.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  error: "No valid client IDs provided",
                  validClientIds: Array.from(validClientIds),
                },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }
      transforms = transforms.filter((t: { clientId: string }) =>
        filter.includes(t.clientId)
      );
    }

    const warnings = analyzeEmail(html, toFramework(format));
    const scores = generateCompatibilityScore(warnings);

    const darkMode: Record<string, { html: string; warnings: CSSWarning[] }> =
      {};
    for (const t of transforms) {
      darkMode[t.clientId] = simulateDarkMode(t.html, t.clientId);
    }

    const scoreValues = Object.values(scores);
    const overallScore =
      scoreValues.length > 0
        ? Math.round(
            scoreValues.reduce(
              (a: number, b: { score: number }) => a + b.score,
              0
            ) / scoreValues.length
          )
        : 0;

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              overallScore,
              compatibilityScores: scores,
              cssWarnings: warnings.map((w: CSSWarning) => ({
                client: w.client,
                property: w.property,
                severity: w.severity,
                message: w.message,
                suggestion: w.suggestion,
                fix: w.fix,
                fixType: w.fixType,
              })),
              clientCount: transforms.length,
              darkModeWarnings: Object.entries(darkMode).reduce(
                (
                  acc: Record<string, number>,
                  [clientId, dm]: [string, { warnings: CSSWarning[] }]
                ) => {
                  if (dm.warnings.length > 0) {
                    acc[clientId] = dm.warnings.length;
                  }
                  return acc;
                },
                {}
              ),
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ── Tool: analyze_email ─────────────────────────────────────────
server.registerTool(
  "analyze_email",
  {
    title: "Analyze Email",
    description:
      "Quick CSS compatibility analysis — returns warnings and per-client scores without full transforms. Faster than preview_email when you only need the compatibility report.",
    inputSchema: {
      html: z.string().describe("The email HTML source code"),
      format: z
        .enum(["html", "jsx", "mjml", "maizzle"])
        .optional()
        .describe(
          "Input format: 'html' (default), 'jsx' (React Email), 'mjml', or 'maizzle'. Determines which framework-specific fix snippets are returned."
        ),
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
    const warnings = analyzeEmail(html, toFramework(format));
    const scores = generateCompatibilityScore(warnings);

    const scoreValues = Object.values(scores);
    const overallScore =
      scoreValues.length > 0
        ? Math.round(
            scoreValues.reduce(
              (a: number, b: { score: number }) => a + b.score,
              0
            ) / scoreValues.length
          )
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
              warnings: warnings.map((w: CSSWarning) => ({
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
            2
          ),
        },
      ],
    };
  }
);

// ── Tool: fix_email ─────────────────────────────────────────────
server.registerTool(
  "fix_email",
  {
    title: "Fix Email",
    description:
      "Generate a structured fix prompt for email compatibility issues. Returns a markdown prompt with the original code, all detected issues (with fix type: CSS or structural), fix snippets, and format-specific instructions. The AI assistant can then apply these fixes directly. Use after preview_email or analyze_email to fix the issues found.",
    inputSchema: {
      html: z.string().describe("The email HTML source code to fix"),
      format: z
        .enum(["html", "jsx", "mjml", "maizzle"])
        .optional()
        .describe(
          "Input format: 'html' (default), 'jsx' (React Email), 'mjml', or 'maizzle'. Controls the fix syntax in the prompt."
        ),
      scope: z
        .enum(["all", "current"])
        .optional()
        .describe(
          "Fix scope: 'all' (default) fixes for all clients, 'current' fixes for a single client (requires selectedClientId)."
        ),
      selectedClientId: z
        .string()
        .optional()
        .describe(
          "Client ID to scope fixes to (e.g. 'outlook-windows'). Only used when scope is 'current'."
        ),
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
            text: JSON.stringify(
              { message: "No compatibility issues found — nothing to fix.", overallScore: 100 },
              null,
              2
            ),
          },
        ],
      };
    }

    // Estimate tokens
    const estimate = await estimateAiFixTokens({
      originalHtml: html,
      warnings,
      scores,
      scope: fixScope,
      selectedClientId,
      format: inputFormat,
    });

    // Generate the fix prompt
    const prompt = generateFixPrompt({
      originalHtml: html,
      warnings,
      scores,
      scope: fixScope,
      selectedClientId,
      format: inputFormat,
    });

    const structuralWarnings = warnings.filter((w) => w.fixType === "structural");

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              totalWarnings: warnings.length,
              structuralWarnings: structuralWarnings.length,
              cssWarnings: warnings.length - structuralWarnings.length,
              tokenEstimate: {
                inputTokens: estimate.inputTokens,
                estimatedOutputTokens: estimate.estimatedOutputTokens,
                truncated: estimate.truncated,
              },
              note: "Apply the fixes in the prompt below to the email code. Structural issues require HTML restructuring (tables, VML conditionals), not just CSS changes.",
            },
            null,
            2
          ),
        },
        {
          type: "text" as const,
          text: prompt,
        },
      ],
    };
  }
);

// ── Tool: list_clients ──────────────────────────────────────────
server.registerTool(
  "list_clients",
  {
    title: "List Email Clients",
    description:
      "List all 12 supported email client IDs, display names, categories, rendering engines, and dark mode support.",
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
            EMAIL_CLIENTS.map(
              (c: {
                id: string;
                name: string;
                category: string;
                engine: string;
                darkModeSupport: boolean;
              }) => ({
                id: c.id,
                name: c.name,
                category: c.category,
                engine: c.engine,
                darkModeSupport: c.darkModeSupport,
              })
            ),
            null,
            2
          ),
        },
      ],
    };
  }
);

// ── Start ────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
