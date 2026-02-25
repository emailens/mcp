#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  transformForAllClients,
  analyzeEmail,
  generateCompatibilityScore,
  simulateDarkMode,
  EMAIL_CLIENTS,
  type Framework,
} from "@emailens/engine";

function toFramework(format?: string): Framework | undefined {
  if (format === "jsx" || format === "mjml" || format === "maizzle") return format;
  return undefined;
}

const server = new McpServer({
  name: "emailens",
  version: "0.1.0",
});

// ── Tool: preview_email ─────────────────────────────────────────
// @ts-expect-error — MCP SDK overload causes deep type instantiation
server.tool(
  "preview_email",
  "Analyze an HTML email and see how it renders across 12 email clients (including HEY Mail and Superhuman). Returns CSS transforms, compatibility warnings, fix suggestions, dark mode simulation, and per-client scores.",
  {
    html: z.string().describe("The email HTML source code"),
    clients: z
      .array(z.string())
      .optional()
      .describe(
        "Optional array of client IDs to filter (e.g. ['gmail_web', 'outlook_windows']). Omit for all clients."
      ),
    format: z
      .enum(["html", "jsx", "mjml", "maizzle"])
      .optional()
      .describe(
        "Input format of the email source: 'html' (default), 'jsx' (React Email), 'mjml', or 'maizzle'. Controls which framework-specific fix snippets appear in the warnings."
      ),
  },
  async ({ html, clients, format }) => {
    const validClientIds = new Set(EMAIL_CLIENTS.map((c) => c.id));

    let transforms = transformForAllClients(html);
    if (clients) {
      const filter = clients.filter((c) => validClientIds.has(c));
      transforms = transforms.filter((t) => filter.includes(t.clientId));
    }

    const warnings = analyzeEmail(html, toFramework(format));
    const scores = generateCompatibilityScore(warnings);

    const darkMode: Record<
      string,
      { html: string; warnings: typeof warnings }
    > = {};
    for (const t of transforms) {
      darkMode[t.clientId] = simulateDarkMode(t.html, t.clientId);
    }

    const scoreValues = Object.values(scores);
    const overallScore =
      scoreValues.length > 0
        ? Math.round(
            scoreValues.reduce((a, b) => a + b.score, 0) / scoreValues.length
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
              cssWarnings: warnings.map((w) => ({
                client: w.client,
                property: w.property,
                severity: w.severity,
                fix: w.fix,
              })),
              clientCount: transforms.length,
              darkModeWarnings: Object.entries(darkMode).reduce(
                (acc, [clientId, dm]) => {
                  if (dm.warnings.length > 0) {
                    acc[clientId] = dm.warnings.length;
                  }
                  return acc;
                },
                {} as Record<string, number>
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
server.tool(
  "analyze_email",
  "Quick CSS compatibility analysis — returns warnings and per-client scores without full transforms.",
  {
    html: z.string().describe("The email HTML source code"),
    format: z
      .enum(["html", "jsx", "mjml", "maizzle"])
      .optional()
      .describe(
        "Input format: 'html' (default), 'jsx' (React Email), 'mjml', or 'maizzle'. Determines which framework-specific fix snippets are returned."
      ),
  },
  async ({ html, format }) => {
    const warnings = analyzeEmail(html, toFramework(format));
    const scores = generateCompatibilityScore(warnings);

    const scoreValues = Object.values(scores);
    const overallScore =
      scoreValues.length > 0
        ? Math.round(
            scoreValues.reduce((a, b) => a + b.score, 0) / scoreValues.length
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
              warnings: warnings.map((w) => ({
                client: w.client,
                property: w.property,
                severity: w.severity,
                message: w.message,
                fix: w.fix,
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

// ── Tool: list_clients ──────────────────────────────────────────
server.tool(
  "list_clients",
  "List all supported email client IDs and their display names.",
  {},
  async () => {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            EMAIL_CLIENTS.map((c) => ({ id: c.id, name: c.name })),
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
