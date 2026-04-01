import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";

/**
 * Integration tests for MCP tool behavior.
 *
 * Spawns the MCP server as a subprocess and communicates via JSON-RPC
 * over stdin/stdout — the same way real MCP clients connect.
 */

let proc: Subprocess<"pipe", "pipe", "pipe">;
let reqId = 0;

function nextId() {
  return ++reqId;
}

async function sendRequest(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const id = nextId();
  const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
  proc.stdin.write(msg);
  proc.stdin.flush();

  // Read response lines until we get one matching our id
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) throw new Error("Server closed before responding");
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.id === id) {
          reader.releaseLock();
          return parsed;
        }
      } catch {
        // partial JSON, keep reading
      }
    }
    // Keep only the last incomplete line in buffer
    buffer = lines[lines.length - 1];
  }
}

async function callTool(name: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const response = await sendRequest("tools/call", { name, arguments: args }) as { result?: unknown; error?: unknown };
  if (response.error) throw new Error(`MCP error: ${JSON.stringify(response.error)}`);
  return response.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
}

function parseToolJson(result: { content: Array<{ type: string; text: string }> }): unknown {
  return JSON.parse(result.content[0].text);
}

beforeAll(async () => {
  // Ensure no API key is set so hosted tools return upgrade prompts
  const env = { ...process.env };
  delete env.EMAILENS_API_KEY;
  delete env.EMAILENS_API_URL;

  proc = Bun.spawn(["bun", "run", "src/index.ts"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env,
    cwd: import.meta.dir + "/..",
  });

  // Initialize MCP connection
  await sendRequest("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "0.1.0" },
  });

  // Send initialized notification (no response expected)
  const notif = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n";
  proc.stdin.write(notif);
  proc.stdin.flush();

  // Give server a moment to process
  await new Promise((r) => setTimeout(r, 200));
});

afterAll(() => {
  proc?.kill();
});

const SIMPLE_HTML = `<html><head><title>Test</title></head><body><table><tr><td style="padding:10px;font-family:Arial,sans-serif;">Hello</td></tr></table></body></html>`;
const BAD_HTML = `<html><head><style>body{display:grid;gap:20px;position:sticky;backdrop-filter:blur(10px);clip-path:circle();animation:spin 1s infinite}@keyframes spin{to{transform:rotate(360deg)}}</style></head><body><div style="display:flex;gap:16px;max-width:600px;border-radius:8px;word-break:break-all;box-shadow:0 2px 8px rgba(0,0,0,0.1);background-image:linear-gradient(to right,#fff,#eee);position:relative;overflow:hidden;text-overflow:ellipsis">Hello</div></body></html>`;

describe("analyze_email", () => {
  test("returns CSS-only output — no spam, links, a11y, or images fields", async () => {
    const result = await callTool("analyze_email", { html: SIMPLE_HTML });
    const data = parseToolJson(result) as Record<string, unknown>;

    expect(data).toHaveProperty("overallScore");
    expect(data).toHaveProperty("scores");
    expect(data).toHaveProperty("warningCount");
    expect(data).toHaveProperty("warnings");

    // BREAKING CHANGE: these must NOT be present
    expect(data).not.toHaveProperty("spam");
    expect(data).not.toHaveProperty("links");
    expect(data).not.toHaveProperty("accessibility");
    expect(data).not.toHaveProperty("images");
    expect(data).not.toHaveProperty("inboxPreview");
    expect(data).not.toHaveProperty("size");
    expect(data).not.toHaveProperty("templateVariables");
  });
});

describe("audit_email", () => {
  test("returns all report sections", async () => {
    const result = await callTool("audit_email", { html: SIMPLE_HTML });
    const data = parseToolJson(result) as Record<string, unknown>;

    expect(data).toHaveProperty("overallCompatibility");
    expect(data).toHaveProperty("compatibility");
    expect(data).toHaveProperty("spam");
    expect(data).toHaveProperty("links");
    expect(data).toHaveProperty("accessibility");
    expect(data).toHaveProperty("images");
    expect(data).toHaveProperty("inboxPreview");
    expect(data).toHaveProperty("size");
    expect(data).toHaveProperty("templateVariables");
  });
});

describe("preview_email", () => {
  test("includes inboxPreview and sizeReport in output", async () => {
    const result = await callTool("preview_email", { html: SIMPLE_HTML });
    const data = parseToolJson(result) as Record<string, unknown>;

    expect(data).toHaveProperty("overallScore");
    expect(data).toHaveProperty("compatibilityScores");
    expect(data).toHaveProperty("inboxPreview");
    expect(data).toHaveProperty("sizeReport");
    expect(data).toHaveProperty("clientCount");
    expect(data).toHaveProperty("darkModeWarnings");
  });

  test("shows tip when no API key and score < 90", async () => {
    const result = await callTool("preview_email", { html: BAD_HTML });
    const data = parseToolJson(result) as Record<string, unknown>;

    expect((data.overallScore as number)).toBeLessThan(90);
    expect(data).toHaveProperty("tip");
    expect(data.tip as string).toContain("ref=mcp");
  });

  test("no tip when score >= 90", async () => {
    const result = await callTool("preview_email", { html: SIMPLE_HTML });
    const data = parseToolJson(result) as Record<string, unknown>;

    // Simple table-based HTML should score well
    if ((data.overallScore as number) >= 90) {
      expect(data).not.toHaveProperty("tip");
    }
  });

  test("filters to specific clients", async () => {
    const result = await callTool("preview_email", {
      html: SIMPLE_HTML,
      clients: ["gmail-web", "outlook-windows"],
    });
    const data = parseToolJson(result) as Record<string, unknown>;

    expect(data.clientCount).toBe(2);
  });
});

describe("list_clients", () => {
  test("returns 15 clients with required fields", async () => {
    const result = await callTool("list_clients", {});
    const clients = parseToolJson(result) as Array<Record<string, unknown>>;

    expect(clients.length).toBe(15);
    for (const c of clients) {
      expect(c).toHaveProperty("id");
      expect(c).toHaveProperty("name");
      expect(c).toHaveProperty("category");
      expect(c).toHaveProperty("engine");
      expect(c).toHaveProperty("darkModeSupport");
    }
  });

  test("includes deprecated field for outlook-windows-legacy", async () => {
    const result = await callTool("list_clients", {});
    const clients = parseToolJson(result) as Array<Record<string, unknown>>;

    const legacy = clients.find((c) => c.id === "outlook-windows-legacy");
    expect(legacy).toBeDefined();
    expect(legacy!.deprecated).toBe("2026-10");
  });

  test("includes new Outlook iOS and Android clients", async () => {
    const result = await callTool("list_clients", {});
    const clients = parseToolJson(result) as Array<Record<string, unknown>>;
    const ids = clients.map((c) => c.id);

    expect(ids).toContain("outlook-ios");
    expect(ids).toContain("outlook-android");
  });
});

describe("diff_emails", () => {
  test("shows improvement when fixing issues", async () => {
    const result = await callTool("diff_emails", { before: BAD_HTML, after: SIMPLE_HTML });
    const data = parseToolJson(result) as { summary: Record<string, number>; results: unknown[] };

    expect(data.summary.clientsImproved).toBeGreaterThan(0);
    expect(data.summary.clientsRegressed).toBe(0);
    expect(data.summary.avgScoreDelta).toBeGreaterThan(0);
    expect(data.results.length).toBe(15);
  });
});

describe("capture_screenshots", () => {
  test("returns upgrade prompt when no API key", async () => {
    const result = await callTool("capture_screenshots", { html: SIMPLE_HTML });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("requires an Emailens API key");
    expect(result.content[0].text).toContain("ref=mcp");
    expect(result.content[0].text).toContain("EMAILENS_API_KEY");
  });
});

describe("share_preview", () => {
  test("returns upgrade prompt when no API key", async () => {
    const result = await callTool("share_preview", { html: SIMPLE_HTML });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("requires an Emailens API key");
    expect(result.content[0].text).toContain("Dev plan");
    expect(result.content[0].text).toContain("ref=mcp");
  });
});
