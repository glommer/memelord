import { describe, expect, test } from "bun:test";

import { buildSessionStartContext } from "../../packages/cli/src/opencode/plugin-template";

describe("buildSessionStartContext", () => {
  test("empty memories returns only instructions (no memories header)", () => {
    const out = buildSessionStartContext([]);
    expect(out.includes("# Memories from past sessions")).toBe(false);
    expect(out.includes("# Memory system instructions")).toBe(true);
  });

  test("single memory has correct format and weight precision", () => {
    const out = buildSessionStartContext([
      { id: "abc", category: "correction", content: "The lesson content", weight: 1.5 } as any,
    ]);

    expect(out.includes("# Memories from past sessions")).toBe(true);
    expect(out.includes("[correction] (id: abc, weight: 1.50)\nThe lesson content\n\n")).toBe(true);
    expect(out.includes("# Memory system instructions")).toBe(true);
  });

  test("multiple memories list in order", () => {
    const out = buildSessionStartContext([
      { id: "a", category: "insight", content: "one", weight: 2.0 } as any,
      { id: "b", category: "correction", content: "two", weight: 0.25 } as any,
    ]);
    const idx1 = out.indexOf("[insight] (id: a");
    const idx2 = out.indexOf("[correction] (id: b");
    expect(idx1).toBeGreaterThanOrEqual(0);
    expect(idx2).toBeGreaterThan(idx1);
  });
});
