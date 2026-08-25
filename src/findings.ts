import { EMAIL_CLIENTS, type CSSWarning, type SourceLocation } from "@emailens/engine";

/**
 * Turning the engine's per-client warnings into something a model can afford
 * to read.
 *
 * The engine reports per client because a score is per client, and per selector
 * because a fix is per selector. On an ordinary 11KB newsletter that is 347
 * warnings, which collapse to **46 distinct property-and-severity pairs**.
 * `border-radius` alone arrives twelve times: two clients that drop it, six
 * selectors that use it, the same sentence and the same VML workaround in every
 * one. Serialised with the fix snippets that is 286KB, about 73,000 tokens, for
 * an email the size of a README.
 *
 * A tool that cannot be called twice in a conversation gets called once and
 * then avoided, so this collapses the duplication:
 *
 * - **One entry per property and severity**, listing the clients it affects.
 *   The clients are the data; repeating the prose once per client is not.
 * - **The message loses the client's name**, which is the only thing that
 *   differed between the copies. It is stripped by exact match against the
 *   client's own display name rather than by pattern, so it cannot eat a real
 *   word.
 * - **No `fix` snippets.** They were 93KB of the 286KB, and `fix_email` exists
 *   precisely to produce them for the issues a caller decides to act on.
 * - **Positions merge.** Every place the property breaks, across every client
 *   and selector, in document order.
 *
 * `detail: "full"` returns the engine's own per-client shape, unchanged, for a
 * caller that genuinely wants it.
 */

const CLIENT_NAMES = new Map(EMAIL_CLIENTS.map((c) => [c.id, c.name]));

/** One problem, and everywhere it lands. */
export interface CollapsedFinding {
  property: string;
  severity: CSSWarning["severity"];
  /** Client ids affected, in the matrix's own order. */
  clients: string[];
  /** The engine's message with the client's name removed. */
  message: string;
  suggestion?: string;
  /** `structural` means the fix changes markup, not just CSS. */
  fixType?: CSSWarning["fixType"];
  /** True when `fix_email` can produce a snippet for this. */
  hasFix?: boolean;
  loc?: Pick<SourceLocation, "line" | "column" | "offset" | "length">;
  alsoAtLines?: number[];
  locsTruncated?: boolean;
}

/**
 * Strip the leading client name from a message.
 *
 * Messages read "Outlook (New) does not support …" / "Yahoo Mail has partial
 * support for …". Matching the client's own display name exactly is safer than
 * a pattern: "Mail" and "Outlook" appear inside real sentences.
 */
function withoutClientName(message: string, clientId: string): string {
  const name = CLIENT_NAMES.get(clientId);
  if (!name || !message.startsWith(name)) return message;
  const rest = message.slice(name.length).trimStart();
  return rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : message;
}

/** Positions from every warning in a group, deduplicated, in document order. */
function mergeLocations(group: CSSWarning[]): SourceLocation[] {
  const byOffset = new Map<number, SourceLocation>();
  for (const w of group) {
    for (const loc of w.locs ?? (w.loc ? [w.loc] : [])) {
      if (!byOffset.has(loc.offset)) byOffset.set(loc.offset, loc);
    }
  }
  return [...byOffset.values()].sort((a, b) => a.offset - b.offset);
}

/**
 * Collapse per-client, per-selector warnings into one entry each.
 *
 * Grouped by property, severity **and message**: two clients can both drop a
 * property for different reasons, and merging those would attribute a caveat
 * to a client whose note never said it.
 */
export function collapseWarnings(warnings: CSSWarning[]): CollapsedFinding[] {
  const groups = new Map<string, CSSWarning[]>();
  for (const w of warnings) {
    // A NUL separator, because it cannot occur in a property, a severity or
    // a message; a space could, and two different triples would collide.
    const key = [w.property, w.severity, withoutClientName(w.message, w.client)].join("\u0000");
    const seen = groups.get(key);
    if (seen) seen.push(w);
    else groups.set(key, [w]);
  }

  return [...groups.values()].map((group) => {
    const first = group[0];
    const clients = [...new Set(group.map((w) => w.client))];
    const locs = mergeLocations(group);
    // A suggestion can differ per client (5 of 46 groups on the reference
    // fixture). Keeping the first would silently attribute one client's advice
    // to another, so a group that disagrees says nothing and lets the caller
    // ask `fix_email`.
    const suggestions = new Set(group.map((w) => w.suggestion ?? ""));
    const suggestion = suggestions.size === 1 ? first.suggestion : undefined;

    return {
      property: first.property,
      severity: first.severity,
      clients,
      message: withoutClientName(first.message, first.client),
      ...(suggestion ? { suggestion } : {}),
      ...(first.fixType ? { fixType: first.fixType } : {}),
      ...(group.some((w) => w.fix) ? { hasFix: true } : {}),
      ...(locs.length
        ? {
            loc: {
              line: locs[0].line,
              column: locs[0].column,
              offset: locs[0].offset,
              length: locs[0].length,
            },
            // Lines, not positions, and each line once: two occurrences on
            // one line are two offsets but one place to look.
            ...(() => {
              const lines = [...new Set(locs.slice(1).map((l) => l.line))].filter(
                (line) => line !== locs[0].line,
              );
              return lines.length ? { alsoAtLines: lines } : {};
            })(),
          }
        : {}),
      ...(group.some((w) => w.locsTruncated) ? { locsTruncated: true } : {}),
    };
  });
}

/** Keep only the warnings for these clients. An empty or absent list keeps all. */
export function forClients(warnings: CSSWarning[], clients?: string[]): CSSWarning[] {
  if (!clients?.length) return warnings;
  const wanted = new Set(clients);
  return warnings.filter((w) => wanted.has(w.client));
}

/** Every client id the engine knows, for validating a caller's filter. */
export function knownClientIds(): string[] {
  return EMAIL_CLIENTS.map((c) => c.id);
}
