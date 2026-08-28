import { compile } from "@emailens/engine/compile";

/**
 * Getting a template to HTML before anything looks at it.
 *
 * The `format` parameter used to do nothing but choose the syntax of the fix
 * snippets, while the source was handed to the analyzer as-is. That is a quiet
 * and expensive lie: cheerio parses `<mjml><mj-section>…` without complaint,
 * finds no CSS in it, and the tools answer **zero findings**. An assistant
 * reads that as a clean bill of health and says the campaign is fine. A wrong
 * answer delivered confidently is worse than an error.
 *
 * So a non-HTML format is compiled first, with the same compilers the CLI uses.
 * They are optional peer dependencies of the engine (MJML alone is 56MB, and
 * this server is usually run through `npx`), so a caller can land on a machine
 * that has none of them. That case gets the engine's own "install this" message
 * plus the way out that needs nothing installed: compile it yourself and send
 * the HTML.
 */

export type SourceResult = { ok: true; html: string } | { ok: false; message: string };

const COMPILED: ReadonlySet<string> = new Set(["jsx", "mjml", "maizzle"]);

/**
 * Is this "the package isn't here" rather than "the template is wrong"?
 *
 * The engine says `MJML compilation requires "mjml"` for a missing compiler
 * and `Sandbox strategy "isolated-vm" requires the "isolated-vm" package` when
 * the compiler is present but its sandbox is not, which is what React Email
 * hits first. Both are the same problem for the caller, so one pattern covers
 * them. Getting this wrong is cheap in one direction only: a misclassified
 * template error gains an irrelevant sentence, while a misclassified missing
 * package would tell someone to debug markup that is fine.
 */
function isMissingCompiler(message: string): boolean {
  return /requires (?:the )?"/.test(message);
}

/**
 * Compile `source` when `format` names a template language, or pass it through
 * when it is already HTML.
 */
export async function toHtml(source: string, format?: string): Promise<SourceResult> {
  if (!format || format === "html") return { ok: true, html: source };
  if (!COMPILED.has(format)) {
    return { ok: false, message: `Unknown format "${format}". Use html, jsx, mjml, or maizzle.` };
  }

  try {
    return { ok: true, html: await compile(source, format as "jsx" | "mjml" | "maizzle") };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isMissingCompiler(message)) {
      return {
        ok: false,
        message:
          `${message}\n\nThat has to happen where this MCP server runs, which may not be somewhere ` +
          `you can install to. If it is not, compile the template yourself and send the resulting ` +
          `HTML with format "html".`,
      };
    }
    return { ok: false, message };
  }
}
