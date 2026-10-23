import { readFile, realpath, stat } from "node:fs/promises";
import { extname } from "node:path";
import { MAX_HTML_SIZE } from "@emailens/engine";

/**
 * The email a tool works on, passed inline or as a file path.
 *
 * Inline, a 60 KB email travels through the model's context on every call of a
 * lint, fix, re-check loop, and fix_email sends it back once more. A path keeps
 * it on disk: this server runs locally over stdio, beside the files the agent
 * is editing, so it can read them itself.
 *
 * The path is chosen by a model, which a prompt injection can steer, and
 * fix_email echoes its input while capture_screenshots and share_preview upload
 * it. So only email sources are read: the extension is checked on the resolved
 * file, after symlinks, and the size before reading.
 */

// The format a file's extension implies. `.html` implies none: it may be a
// Maizzle template, which only an explicit format can say.
const EXTENSIONS: Record<string, string | undefined> = {
  ".html": undefined,
  ".htm": undefined,
  ".mjml": "mjml",
  ".jsx": "jsx",
  ".tsx": "jsx",
  ".vue": "maizzle",
};

export type Input =
  | { ok: true; html: string; format?: string; path?: string }
  | { ok: false; message: string };

export async function readSource(
  html: string | undefined,
  path: string | undefined,
  format?: string,
  names = { html: "html", path: "path" },
): Promise<Input> {
  if ((html === undefined) === (path === undefined)) {
    return { ok: false, message: `Pass exactly one of \`${names.html}\` (the source) or \`${names.path}\` (a file holding it).` };
  }
  if (html !== undefined) return { ok: true, html, format };

  let real: string;
  try {
    real = await realpath(path!);
  } catch {
    return { ok: false, message: `No file at ${path}. Pass an absolute path, or the source itself as \`${names.html}\`.` };
  }
  const ext = extname(real).toLowerCase();
  if (!(ext in EXTENSIONS)) {
    return { ok: false, message: `${path} is not an email source. Accepted: ${Object.keys(EXTENSIONS).join(", ")}.` };
  }
  const info = await stat(real);
  if (!info.isFile()) return { ok: false, message: `${path} is not a file.` };
  if (info.size > MAX_HTML_SIZE) {
    return { ok: false, message: `${path} exceeds the ${Math.round(MAX_HTML_SIZE / 1024)}KB limit.` };
  }
  return { ok: true, html: await readFile(real, "utf8"), format: format ?? EXTENSIONS[ext], path: real };
}

/**
 * fix_email's prompt without the source, when the caller has it on disk.
 *
 * The engine embeds the whole source as a fenced block; on a path that is the
 * largest part of the response and something the agent can read itself.
 */
export function withoutSource(prompt: string, html: string, format: string, path: string): string {
  return prompt.replace(`\`\`\`${format}\n${html}\n\`\`\``, () => `The source is in \`${path}\`. Read and edit it there.`);
}
