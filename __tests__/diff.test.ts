import { describe, test, expect } from "bun:test";
import {
  analyzeEmail,
  generateCompatibilityScore,
  diffResults,
} from "@emailens/engine";

describe("diff_emails summary computation", () => {
  const goodHtml = `<html><head></head><body><table><tr><td style="padding: 20px; font-family: Arial, sans-serif;">Hello</td></tr></table></body></html>`;
  const badHtml = `<html><head></head><body><div style="display: flex; gap: 16px; border-radius: 8px; word-break: break-all;">Hello</div></body></html>`;

  test("diff shows improvement when fixing issues", () => {
    const beforeWarnings = analyzeEmail(badHtml);
    const beforeScores = generateCompatibilityScore(beforeWarnings);
    const afterWarnings = analyzeEmail(goodHtml);
    const afterScores = generateCompatibilityScore(afterWarnings);

    const results = diffResults(
      { scores: beforeScores, warnings: beforeWarnings },
      { scores: afterScores, warnings: afterWarnings },
    );

    let clientsImproved = 0;
    let clientsRegressed = 0;
    let totalDelta = 0;

    for (const r of results) {
      if (r.scoreDelta > 0) clientsImproved++;
      else if (r.scoreDelta < 0) clientsRegressed++;
      totalDelta += r.scoreDelta;
    }

    const avgScoreDelta =
      results.length > 0 ? Math.round((totalDelta / results.length) * 10) / 10 : 0;

    expect(clientsImproved).toBeGreaterThan(0);
    expect(clientsRegressed).toBe(0);
    expect(avgScoreDelta).toBeGreaterThan(0);
    expect(results.length).toBe(15);
  });

  test("diff shows regression when introducing issues", () => {
    const beforeWarnings = analyzeEmail(goodHtml);
    const beforeScores = generateCompatibilityScore(beforeWarnings);
    const afterWarnings = analyzeEmail(badHtml);
    const afterScores = generateCompatibilityScore(afterWarnings);

    const results = diffResults(
      { scores: beforeScores, warnings: beforeWarnings },
      { scores: afterScores, warnings: afterWarnings },
    );

    let clientsRegressed = 0;
    for (const r of results) {
      if (r.scoreDelta < 0) clientsRegressed++;
    }

    expect(clientsRegressed).toBeGreaterThan(0);
  });

  test("diff shows no change for identical HTML", () => {
    const warnings = analyzeEmail(goodHtml);
    const scores = generateCompatibilityScore(warnings);

    const results = diffResults(
      { scores, warnings },
      { scores, warnings },
    );

    for (const r of results) {
      expect(r.scoreDelta).toBe(0);
      expect(r.fixed.length).toBe(0);
      expect(r.introduced.length).toBe(0);
    }
  });
});
