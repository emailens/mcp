import { EMAIL_CLIENTS } from "@emailens/engine";
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";

/**
 * Integration tests for MCP tool behavior.
 *
 * Spawns the MCP server as a subprocess and communicates via JSON-RPC
 * over stdin/stdout: the same way real MCP clients connect.
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
  test("returns CSS-only output: no spam, links, a11y, or images fields", async () => {
    const result = await callTool("analyze_email", { html: SIMPLE_HTML });
    const data = parseToolJson(result) as Record<string, unknown>;

    expect(data).toHaveProperty("overallScore");
    expect(data).toHaveProperty("scores");
    expect(data).toHaveProperty("warningCount");
    expect(data).toHaveProperty("findingCount");
    expect(data).toHaveProperty("findings");

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
    expect(data).toHaveProperty("overflow");
    expect(data).toHaveProperty("visual");
    expect(data).toHaveProperty("darkContrast");
    expect(data).toHaveProperty("mobileContrast");
    expect(data).toHaveProperty("design");
    expect(data).toHaveProperty("vml");
  });

  // An email that actually trips the two new checks: the dark block repaints
  // the card without re-colouring the text on it, and the two off-whites are
  // the same colour to a reader.
  const DARK_AND_DRIFTY = `<html lang="en"><head><title>Receipt</title><style>
    @media (prefers-color-scheme: dark){ .card{background-color:#141519 !important} }
  </style></head><body style="background:#f0ece4">
    <table class="card" role="presentation"><tr><td style="color:#1a1714;font-size:14px">
      <div>Archival Linen Notebook</div>
    </td></tr></table>
    <div style="color:#eae6de;font-size:14px">a</div>
    <div style="color:#f4f2ed;font-size:14px">b</div>
  </body></html>`;

  // VML lives inside conditional comments, so it is a comment node to every
  // parser: the one section of an email no other check in this tool can see.
  const NESTED_VML = `<html xmlns:v="urn:schemas-microsoft-com:vml"><body>
    <!--[if gte mso 9]><v:rect style="width:596px; height:px;"><v:textbox><![endif]-->
    <p>hero</p>
    <!--[if mso]><v:roundrect style="width:170px; height:40px;" arcsize="120%"><center>Go</center></v:roundrect><![endif]-->
    <!--[if gte mso 9]></v:textbox></v:rect><![endif]-->
  </body></html>`;

  test("reports VML faults that live inside conditional comments", async () => {
    const data = parseToolJson(
      await callTool("audit_email", { html: NESTED_VML }),
    ) as Record<string, unknown>;

    const vml = data.vml as { hasVml: boolean; issues: Array<{ rule: string }> };
    expect(vml.hasVml).toBe(true);
    const rules = vml.issues.map((i) => i.rule);
    expect(rules).toContain("vml-nested-shape");
    expect(rules).toContain("vml-invalid-dimension");
    expect(rules).toContain("vml-arcsize-range");
  });

  test("skip:['vml'] omits the VML section", async () => {
    const skipped = parseToolJson(
      await callTool("audit_email", { html: NESTED_VML, skip: ["vml"] }),
    ) as Record<string, unknown>;
    expect((skipped.vml as { issues: unknown[] }).issues).toEqual([]);
    expect(skipped).toHaveProperty("accessibility");
  });

  // CSS a client parses correctly and then throws away. No support matrix can
  // express it, so nothing else in the report covers it.
  const DISCARDED_CSS = `<!DOCTYPE html><html><head><style>
    @media screen{div{color:#fff}}
    .promo{background:rgb(255 0 0)}
  </style></head><body><p>hi</p></body></html>`;

  test("reports CSS a client keeps nothing of", async () => {
    const data = parseToolJson(
      await callTool("audit_email", { html: DISCARDED_CSS }),
    ) as Record<string, unknown>;

    const survival = data.styleSurvival as {
      issues: Array<{ rule: string; clients: string[] }>;
    };
    const rules = survival.issues.map((i) => i.rule);
    expect(rules).toContain("outlook-double-brace");
    expect(rules).toContain("gmail-space-separated-color");
    // The clients are the finding: an issue that cannot name them does not
    // group correctly on the consuming side.
    for (const issue of survival.issues) {
      expect([issue.rule, issue.clients.length > 0]).toEqual([issue.rule, true]);
    }
  });

  test("skip:['styleSurvival'] omits the section", async () => {
    const skipped = parseToolJson(
      await callTool("audit_email", { html: DISCARDED_CSS, skip: ["styleSurvival"] }),
    ) as Record<string, unknown>;
    expect((skipped.styleSurvival as { issues: unknown[] }).issues).toEqual([]);
    expect(skipped).toHaveProperty("accessibility");
  });

  test("skip omits the work a caller did not ask for", async () => {
    const full = parseToolJson(
      await callTool("audit_email", { html: DARK_AND_DRIFTY }),
    ) as Record<string, unknown>;

    // Guard the fixture: without this the skip assertion below proves nothing.
    expect((full.darkContrast as unknown[]).length).toBeGreaterThan(0);
    expect((full.design as { issues: unknown[] }).issues.length).toBeGreaterThan(0);

    const skipped = parseToolJson(
      await callTool("audit_email", {
        html: DARK_AND_DRIFTY,
        skip: ["darkContrast", "design"],
      }),
    ) as Record<string, unknown>;

    expect(skipped.darkContrast).toEqual([]);
    expect((skipped.design as { issues: unknown[] }).issues).toEqual([]);
    expect(skipped).toHaveProperty("accessibility");
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
  test("returns 21 clients with required fields", async () => {
    const result = await callTool("list_clients", {});
    const clients = parseToolJson(result) as Array<Record<string, unknown>>;

    expect(clients.length).toBe(21);
    for (const c of clients) {
      expect(c).toHaveProperty("id");
      expect(c).toHaveProperty("name");
      expect(c).toHaveProperty("category");
      expect(c).toHaveProperty("engine");
      expect(c).toHaveProperty("darkModeSupport");
    }
  });

  test("passes the engine's deprecation date through rather than its own", async () => {
    // This asserted "2026-10" until Microsoft moved Outlook Classic's
    // end-of-support date and the engine's data followed. A date owned
    // upstream does not belong in an assertion here; what this tool owes its
    // caller is the engine's answer, unaltered.
    const result = await callTool("list_clients", {});
    const clients = parseToolJson(result) as Array<Record<string, unknown>>;

    const legacy = clients.find((c) => c.id === "outlook-windows-legacy");
    const source = EMAIL_CLIENTS.find((c) => c.id === "outlook-windows-legacy");
    expect(legacy).toBeDefined();
    expect(source?.deprecated).toEqual(expect.any(String));
    expect(legacy!.deprecated).toBe(source!.deprecated);
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
    expect(data.results.length).toBe(EMAIL_CLIENTS.length);
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

describe("source positions", () => {
  const POSITIONED = [
    /* 1 */ '<html lang="en">',
    /* 2 */ "<head><style>",
    /* 3 */ "  .card { border-radius: 8px; }",
    /* 4 */ "</style></head>",
    /* 5 */ "<body>",
    /* 6 */ '  <a href="http://example.com">go</a>',
    /* 7 */ '  <div style="border-radius:4px">a</div>',
    /* 8 */ '  <div style="border-radius:4px">b</div>',
    /* 9 */ "</body></html>",
  ].join("\n");

  interface Finding {
    property: string;
    clients: string[];
    loc?: { line: number; column: number; offset: number; length: number };
    alsoAtLines?: number[];
  }

  async function findings(args: Record<string, unknown> = {}): Promise<Finding[]> {
    const result = await callTool("analyze_email", { html: POSITIONED, ...args });
    return (parseToolJson(result) as { findings: Finding[] }).findings;
  }

  test("analyze_email locates the finding in the HTML it was given", async () => {
    const radius = (await findings()).filter((f) => f.property === "border-radius" && f.loc);

    // border-radius appears three times here, once in the <style> block and
    // once in each <div>, and is dropped by the same clients for the same
    // reason every time. That is one problem in three places, so it is one
    // finding: `loc` on the first, the rest as lines.
    expect(radius).toHaveLength(1);
    const { loc, alsoAtLines } = radius[0];
    expect(POSITIONED.slice(loc!.offset, loc!.offset + loc!.length)).toBe("border-radius: 8px");
    expect(alsoAtLines).toEqual([7, 8]);
  });

  test("an agent is told about every place a property breaks", async () => {
    // An agent fixing only `loc` would leave the two <div>s broken.
    const radius = (await findings()).find((f) => f.property === "border-radius")!;
    expect(radius.alsoAtLines).toEqual([7, 8]);
    expect(radius.clients.length).toBeGreaterThan(1);
  });

  test("positions stay compact: the response is read by a model", async () => {
    const located = (await findings()).find((f) => f.loc)!;
    expect(Object.keys(located.loc!).sort()).toEqual(["column", "length", "line", "offset"]);
  });

  test("detail:'full' still gives the per-client breakdown", async () => {
    // The escape hatch. Nothing the collapsed shape leaves out is unreachable.
    const result = await callTool("analyze_email", { html: POSITIONED, detail: "full" });
    const data = parseToolJson(result) as {
      warnings: Array<{ client: string; property: string; fix?: unknown }>;
    };
    const radius = data.warnings.filter((w) => w.property === "border-radius");
    expect(radius.length).toBeGreaterThan(1);
    expect(new Set(radius.map((w) => w.client)).size).toBeGreaterThan(1);
    expect(radius.some((w) => w.fix)).toBe(true);
  });

  test("an unknown client id is rejected, not silently filtered to nothing", async () => {
    // The most misleading thing the tool can do with a typo is return an empty
    // list, which reads as "this email is fine for that client".
    const result = await callTool("analyze_email", {
      html: POSITIONED,
      clients: ["outlook-2019", "gmail-web"],
    });
    expect(result.isError).toBe(true);
    const text = result.content.map((c) => c.text).join(" ");
    expect(text).toContain("outlook-2019");
    expect(text).not.toContain("gmail-web");
    expect(text).toContain("list_clients");
  });

  test("clients narrows what is reported without changing the scores", async () => {
    const result = await callTool("analyze_email", {
      html: POSITIONED,
      clients: ["outlook-windows"],
    });
    const data = parseToolJson(result) as {
      scores: Record<string, unknown>;
      findings: Finding[];
    };
    for (const f of data.findings) expect(f.clients).toEqual(["outlook-windows"]);
    // Scores stay whole-email: asking about one client narrows the report, it
    // does not change what the email is worth everywhere else.
    expect(Object.keys(data.scores).length).toBeGreaterThan(1);
  });

  test("audit_email positions findings from every analyzer that has them", async () => {
    const result = await callTool("audit_email", { html: POSITIONED });
    const data = parseToolJson(result) as {
      compatibility: { findings: Array<{ loc?: unknown }> };
      links: { issues: Array<{ rule: string; loc?: { line: number } }> };
    };

    expect(data.compatibility.findings.some((f) => f.loc)).toBe(true);
    const insecure = data.links.issues.find((i) => i.rule === "insecure-link");
    expect(insecure?.loc?.line).toBe(6);
  });

  test("compiled input gets no positions: they would point at generated HTML", async () => {
    // MJML compiles before analysis, so any line number would refer to output
    // the caller never wrote. Better to return none than to mislead an agent
    // into editing the wrong line.
    const result = await callTool("analyze_email", {
      html: "<mjml><mj-body><mj-section><mj-column><mj-text>hi</mj-text></mj-column></mj-section></mj-body></mjml>",
      format: "mjml",
    });
    if (result.isError) return; // mjml peer dep not installed in this environment
    const data = parseToolJson(result) as { findings: Array<{ loc?: unknown }> };
    expect(data.findings.every((f) => !f.loc)).toBe(true);
  });
});
