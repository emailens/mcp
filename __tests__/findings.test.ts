import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeEmail, auditEmail, EMAIL_CLIENTS, type CSSWarning } from "@emailens/engine";
import { collapseWarnings, forClients, knownClientIds } from "../src/findings";

/**
 * The size of the response is the feature here, so it is what these assert,
 * against a real newsletter, not a snippet. An 11KB email produced 286KB of
 * JSON, about 73,000 tokens, which is more than most callers can take in one
 * turn and all of them pay for.
 */

// Vendored rather than reached for in a sibling checkout. It was an absolute
// path into one machine's home directory, so the whole file threw ENOENT
// anywhere else, including on CI, the first time there was any.
const FIXTURE = join(import.meta.dir, "fixtures", "cerberus-newsletter.html");
const html = readFileSync(FIXTURE, "utf8");
const warnings = analyzeEmail(html, undefined, { positions: true });

/** What the old shape cost: one entry per client, carrying its fix snippet. */
function perClientPayload(list: CSSWarning[]): string {
  return JSON.stringify(
    list.map((w) => ({
      client: w.client,
      property: w.property,
      severity: w.severity,
      message: w.message,
      suggestion: w.suggestion,
      fix: w.fix,
      fixType: w.fixType,
      loc: w.loc,
      alsoAtLines: w.locs?.slice(1).map((l) => l.line),
    })),
    null,
    2,
  );
}

describe("collapsing the response", () => {
  test("an ordinary newsletter fits in a conversation", () => {
    const before = perClientPayload(warnings).length;
    const after = JSON.stringify(collapseWarnings(warnings), null, 2).length;
    // Roughly 286KB to 40KB on this fixture. The bound is loose enough to
    // survive a caniemail resync and tight enough to fail if the collapsing
    // stops happening.
    expect(before).toBeGreaterThan(200_000);
    expect(after).toBeLessThan(80_000);
    expect(after / before).toBeLessThan(0.25);
  });

  test("nothing is lost: every warning is represented by a finding", () => {
    const findings = collapseWarnings(warnings);
    const covered = new Set(
      findings.flatMap((f) => f.clients.map((c) => `${f.property}|${f.severity}|${c}`)),
    );
    for (const w of warnings) {
      expect(covered.has(`${w.property}|${w.severity}|${w.client}`)).toBe(true);
    }
    expect(findings.length).toBeLessThan(warnings.length / 4);
  });

  test("a client is never told about a caveat its own note did not make", () => {
    // The failure mode of grouping: two clients drop a property for different
    // reasons and get merged, attributing one client's caveat to another. For
    // every client on a finding there must be an original warning from that
    // client saying exactly this, once its own name is taken off the front.
    const strip = (message: string, clientId: string) => {
      const name = EMAIL_CLIENTS.find((c) => c.id === clientId)!.name;
      if (!message.startsWith(name)) return message;
      const rest = message.slice(name.length).trimStart();
      return rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : message;
    };

    for (const finding of collapseWarnings(warnings)) {
      for (const client of finding.clients) {
        const said = warnings.some(
          (w) =>
            w.client === client &&
            w.property === finding.property &&
            w.severity === finding.severity &&
            strip(w.message, w.client) === finding.message,
        );
        expect([finding.property, client, said]).toEqual([finding.property, client, true]);
      }
    }
  });

  test("a message that names its client mid-sentence stays one per client", () => {
    // The limit of collapsing, stated rather than hidden. Support warnings
    // open with the client's name, so stripping it makes the copies converge.
    // The dark-mode warnings put it in the middle ("…so Apple Mail may keep
    // the email in light mode"), and merging those would print Apple Mail's
    // sentence against Samsung Mail. They stay separate, and should.
    const darkMode = warnings.filter((w) => w.property === "dark-mode-opt-in");
    expect(darkMode.length).toBeGreaterThan(1);
    const collapsed = collapseWarnings(darkMode);
    expect(collapsed.length).toBe(darkMode.length);
    for (const f of collapsed) expect(f.clients).toHaveLength(1);

    // It is a small share of the whole: the bulk is per-client support
    // warnings, and those do collapse.
    const all = collapseWarnings(warnings);
    const perClient = all.filter((f) => f.clients.length === 1).length;
    expect(perClient).toBeLessThan(all.length / 2);
  });

  test("the client's name is stripped, and nothing else is", () => {
    const collapsed = collapseWarnings(warnings);
    for (const f of collapsed) {
      for (const client of EMAIL_CLIENTS) {
        // A message must not open with a client name, that was the duplicated
        // part. It may still mention one in the middle, as caniemail notes do.
        expect([f.property, f.message.startsWith(client.name + " ")]).toEqual([f.property, false]);
      }
      expect(f.message.length).toBeGreaterThan(0);
    }
  });

  test("a suggestion that differs between clients is dropped rather than guessed", () => {
    // Built the way the engine builds them, each message opening with its own
    // client's name, so the two land in one group.
    const base = warnings[0];
    const say = (clientId: string, suggestion: string): CSSWarning => ({
      ...base,
      client: clientId,
      message: `${EMAIL_CLIENTS.find((c) => c.id === clientId)!.name} does not support "gap".`,
      suggestion,
    });

    const disagree = collapseWarnings([say("gmail-web", "do A"), say("outlook-web", "do B")]);
    expect(disagree).toHaveLength(1);
    expect(disagree[0].clients).toEqual(["gmail-web", "outlook-web"]);
    expect(disagree[0].suggestion).toBeUndefined();

    const agree = collapseWarnings([say("gmail-web", "do A"), say("outlook-web", "do A")]);
    expect(agree).toHaveLength(1);
    expect(agree[0].suggestion).toBe("do A");
  });

  test("positions merge across clients and selectors, one line each", () => {
    const finding = collapseWarnings(warnings).find((f) => f.property === "border-radius")!;
    expect(finding.loc).toBeDefined();
    expect(finding.alsoAtLines!.length).toBeGreaterThan(0);
    // The same line twice is two offsets but one place to look, and the first
    // location is already reported by `loc`.
    expect(new Set(finding.alsoAtLines).size).toBe(finding.alsoAtLines!.length);
    expect(finding.alsoAtLines).not.toContain(finding.loc!.line);
    // In document order, and every line is real.
    const sorted = [...finding.alsoAtLines!].sort((a, b) => a - b);
    expect(finding.alsoAtLines).toEqual(sorted);
    const lineCount = html.split("\n").length;
    for (const line of finding.alsoAtLines!) expect(line).toBeLessThanOrEqual(lineCount);
  });

  test("fix snippets are gone, but the caller is told one exists", () => {
    const collapsed = collapseWarnings(warnings);
    const json = JSON.stringify(collapsed);
    expect(json).not.toContain('"fix"');
    expect(collapsed.some((f) => f.hasFix)).toBe(true);
    // fixType survives: it is one word and it says whether the repair is
    // markup or CSS, which changes how a caller plans.
    expect(collapsed.some((f) => f.fixType === "structural")).toBe(true);
  });

  test("a finding with no positions carries no position fields", () => {
    const collapsed = collapseWarnings(analyzeEmail(html));
    expect(collapsed.length).toBeGreaterThan(0);
    for (const f of collapsed) {
      expect(f.loc).toBeUndefined();
      expect(f.alsoAtLines).toBeUndefined();
    }
  });

  test("an empty input collapses to nothing", () => {
    expect(collapseWarnings([])).toEqual([]);
  });
});

describe("narrowing to specific clients", () => {
  test("filtering is the cheapest way to shrink the answer further", () => {
    const all = JSON.stringify(collapseWarnings(warnings)).length;
    const two = JSON.stringify(
      collapseWarnings(forClients(warnings, ["gmail-web", "outlook-windows"])),
    ).length;
    expect(two).toBeLessThan(all / 1.5);
  });

  test("only the named clients come back", () => {
    const scoped = collapseWarnings(forClients(warnings, ["outlook-windows"]));
    expect(scoped.length).toBeGreaterThan(0);
    for (const f of scoped) expect(f.clients).toEqual(["outlook-windows"]);
  });

  test("no filter, or an empty one, keeps everything", () => {
    expect(forClients(warnings, undefined).length).toBe(warnings.length);
    expect(forClients(warnings, []).length).toBe(warnings.length);
  });

  test("an unknown client id returns nothing rather than everything", () => {
    // Silently ignoring a typo would answer a question the caller did not ask.
    expect(forClients(warnings, ["outlook-2019"]).length).toBe(0);
    expect(knownClientIds()).toContain("outlook-windows");
    expect(knownClientIds()).not.toContain("outlook-2019");
  });
});

describe("the audit response", () => {
  test("shrinks by the same margin", () => {
    const report = auditEmail(html, { positions: true });
    const before = JSON.stringify(report, null, 2).length;
    const after = JSON.stringify(
      {
        ...report,
        compatibility: {
          scores: report.compatibility.scores,
          findings: collapseWarnings(report.compatibility.warnings),
        },
      },
      null,
      2,
    ).length;
    expect(before).toBeGreaterThan(300_000);
    expect(after).toBeLessThan(100_000);
  });
});
