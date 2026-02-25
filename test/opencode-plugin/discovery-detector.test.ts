import { describe, expect, test } from "bun:test";

import { buildDiscoverySummary } from "../../packages/cli/src/opencode/plugin-template";

describe("buildDiscoverySummary", () => {
  test("empty texts returns null", () => {
    expect(buildDiscoverySummary([])).toBe(null);
  });

  test("summary under 100 chars returns null", () => {
    const out = buildDiscoverySummary(["x".repeat(40), "y".repeat(40)]);
    expect(out).toBe(null);
  });

  test("takes top 5 by length + last 2, deduplicates, preserves original order", () => {
    const texts = [
      "A".repeat(300),
      "B".repeat(290),
      "C".repeat(280),
      "D".repeat(270),
      "E".repeat(260),
      "SKIP".repeat(60),
      "tail-1".repeat(10),
      "tail-2".repeat(10),
    ];

    const out = buildDiscoverySummary(texts);
    expect(out).not.toBe(null);
    const summary = out ?? "";

    // Includes tail blocks even though they are short.
    expect(summary.includes("tail-1")).toBe(true);
    expect(summary.includes("tail-2")).toBe(true);

    // Does not include the mid-length block that's neither top-5 nor last-2.
    expect(summary.includes("SKIP")).toBe(false);

    // Preserves original order (A before E before tail-1).
    const idxA = summary.indexOf("A");
    const idxE = summary.indexOf("E");
    const idxTail1 = summary.indexOf("tail-1");
    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxE).toBeGreaterThan(idxA);
    expect(idxTail1).toBeGreaterThan(idxE);
  });

  test("each block is truncated to 500 chars before joining", () => {
    const long = "L".repeat(600);
    const out = buildDiscoverySummary([long, "Z".repeat(200)]) ?? "";
    expect(out.includes("L".repeat(500))).toBe(true);
    expect(out.includes("L".repeat(501))).toBe(false);
  });

  test("blocks are joined with two newlines", () => {
    const out = buildDiscoverySummary(["A".repeat(120), "B".repeat(120)]) ?? "";
    expect(out.includes("\n\n")).toBe(true);
  });

  test("total summary is capped at 2000 chars", () => {
    const texts = Array.from({ length: 20 }, (_, i) => `${i}-` + "x".repeat(700));
    const out = buildDiscoverySummary(texts);
    expect(out).not.toBe(null);
    expect((out ?? "").length).toBe(2000);
  });
});
