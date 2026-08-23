import { describe, expect, test } from "bun:test";
import { analyzeEmail } from "@emailens/engine";
import { toHtml } from "../src/compile";

/**
 * The bug these exist for: `format` used to pick the syntax of the fix
 * snippets and nothing else, so an MJML template went to the analyzer as-is.
 * cheerio parses `<mjml><mj-section>` without complaint, finds no CSS, and the
 * tool answers **zero findings** — an assistant reads that as "your email is
 * fine" and says so. The docs claimed the source was compiled; it was not.
 *
 * `mjml` is a devDependency so this runs the real compiler rather than a stub
 * speaking a protocol I assumed.
 */

const MJML = (attrs = "") =>
  `<mjml><mj-body><mj-section><mj-column><mj-text ${attrs}>Hello</mj-text></mj-column></mj-section></mj-body></mjml>`;

describe("getting a template to HTML first", () => {
  test("html passes through untouched, with or without the parameter", async () => {
    const html = "<html><body><p>hi</p></body></html>";
    expect(await toHtml(html, "html")).toEqual({ ok: true, html });
    expect(await toHtml(html, undefined)).toEqual({ ok: true, html });
  });

  test("MJML is compiled, and the findings are real ones from the output", async () => {
    const result = await toHtml(MJML('font-size="1rem"'), "mjml");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.html).toContain("<table");

    const warnings = analyzeEmail(result.html, "mjml");
    const rem = warnings.filter((w) => w.property === "font-size");
    expect(rem.length).toBeGreaterThan(0);
    expect(rem.map((w) => w.client)).toContain("outlook-windows-legacy");
  });

  test("the raw source would have answered 'no problems', which is the whole point", () => {
    // Kept as an assertion rather than a comment: if the engine ever learns to
    // read MJML directly this test fails and the compile step can be revisited.
    expect(analyzeEmail(MJML('font-size="1rem"'), "mjml")).toHaveLength(0);
  });

  test("a validation complaint does not throw the compiled email away", async () => {
    // MJML wants px, says so, and compiles `1rem` anyway. The engine's compiler
    // returns the HTML; failing here would discard a working email.
    const result = await toHtml(MJML('font-size="1rem"'), "mjml");
    expect(result.ok).toBe(true);
  });

  test("markup MJML cannot parse is an error, not an empty result", async () => {
    const result = await toHtml("<p>not mjml at all</p>", "mjml");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/<mjml> element/i);
  });

  test("a compiler this machine lacks names the packages and the way around it", async () => {
    // Maizzle and React Email are optional peers of the engine and are not
    // fully installed here, which is exactly the situation an `npx` caller is
    // in. Which package it names first is the engine's business; that it names
    // one, and offers the way out that needs nothing installed, is ours.
    for (const format of ["maizzle", "jsx"] as const) {
      const result = await toHtml("<div>x</div>", format);
      expect([format, result.ok]).toEqual([format, false]);
      if (result.ok) continue;
      expect([format, /compilation requires "\S+"/.test(result.message)]).toEqual([format, true]);
      expect(result.message).toContain("npm install ");
      expect(result.message).toContain('format "html"');
    }
  });

  test("an unknown format is refused rather than guessed at", async () => {
    const result = await toHtml("<div>x</div>", "handlebars");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("handlebars");
  });
});
