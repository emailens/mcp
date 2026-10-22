/**
 * The first version of each email audited in this session: the design its
 * later revisions are held to. An agent fixing findings rarely passes its own
 * draft back, so the server remembers it.
 *
 * Matched by <title> and then by text, because an agent rewrites markup but
 * keeps the words: a revision shares nearly all its text with the draft,
 * another email with the same title (often just the product name) does not.
 * A revision that rewrites the copy becomes a new draft: a missed comparison,
 * never a false one.
 * ponytail: in-memory, per process, capped; lost on restart, which only means
 * the next audit becomes the draft.
 */

const MAX_DRAFTS = 200;
// Jaccard on words. Measured on the benchmark (359 emails, one title for all):
// two different emails of one product reach 0.48, a fix revision keeps ~all.
const SAME_EMAIL = 0.7;
const drafts = new Map<string, { words: Set<string>; html: string }[]>();

function title(html: string): string {
  return (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim().toLowerCase();
}

function words(html: string): Set<string> {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .toLowerCase();
  return new Set(text.match(/[\p{L}\p{N}]{3,}/gu) ?? []);
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared);
}

/** The draft this html revises, or this html itself when it is a new email. */
export function firstDraft(html: string): string {
  const key = title(html);
  const seen = words(html);
  const list = drafts.get(key) ?? [];
  const best = list
    .map((d) => ({ d, score: overlap(d.words, seen) }))
    .sort((a, b) => b.score - a.score)[0];
  if (best && best.score >= SAME_EMAIL) return best.d.html;
  if ([...drafts.values()].reduce((n, l) => n + l.length, 0) >= MAX_DRAFTS) drafts.clear();
  drafts.set(key, [...list, { words: seen, html }]);
  return html;
}
