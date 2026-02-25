import { describe, expect, test } from "bun:test";

import { analyzeFailurePatterns } from "../../packages/cli/src/opencode/plugin-template";

function jsonl(lines: any[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

describe("analyzeFailurePatterns", () => {
  test("empty JSONL returns empty array", () => {
    expect(analyzeFailurePatterns("")).toEqual([]);
    expect(analyzeFailurePatterns("\n\n")).toEqual([]);
  });

  test("malformed lines are skipped without error", () => {
    const out = analyzeFailurePatterns(
      `not-json\n${JSON.stringify({ tool_name: "read", error_summary: "Error: nope" })}\n`,
    );
    expect(out).toEqual([]);
  });

  test("tool with 2 failures (below threshold) returns empty", () => {
    const out = analyzeFailurePatterns(
      jsonl([
        { tool_name: "read", error_summary: "a" },
        { tool_name: "read", error_summary: "b" },
      ]),
    );
    expect(out).toEqual([]);
  });

  test("tool with 3 failures returns one correction memory candidate", () => {
    const out = analyzeFailurePatterns(
      jsonl([
        { tool_name: "read", error_summary: "first" },
        { tool_name: "read", error_summary: "second" },
        { tool_name: "read", error_summary: "third" },
      ]),
    );
    expect(out.length).toBe(1);
    expect(out[0].category).toBe("correction");
    expect(out[0].weight).toBe(1.0);
    expect(out[0].content).toBe(
      "Repeated failures with read (3x in session): first; second",
    );
  });

  test("tool with 5 failures still only includes 2 examples", () => {
    const out = analyzeFailurePatterns(
      jsonl([
        { tool_name: "bash", error_summary: "a" },
        { tool_name: "bash", error_summary: "b" },
        { tool_name: "bash", error_summary: "c" },
        { tool_name: "bash", error_summary: "d" },
        { tool_name: "bash", error_summary: "e" },
      ]),
    );
    expect(out.length).toBe(1);
    expect(out[0].content.includes("a; b")).toBe(true);
    expect(out[0].content.includes("c")).toBe(false);
  });

  test("example error summaries are truncated to 100 chars", () => {
    const long = "x".repeat(200);
    const out = analyzeFailurePatterns(
      jsonl([
        { tool_name: "read", error_summary: long },
        { tool_name: "read", error_summary: "y".repeat(200) },
        { tool_name: "read", error_summary: "z" },
      ]),
    );
    expect(out.length).toBe(1);
    expect(out[0].content.includes("x".repeat(100))).toBe(true);
    expect(out[0].content.includes("x".repeat(101))).toBe(false);
  });

  test("multiple tools each with >= 3 failures produce multiple candidates", () => {
    const out = analyzeFailurePatterns(
      jsonl([
        { tool_name: "read", error_summary: "a" },
        { tool_name: "read", error_summary: "b" },
        { tool_name: "read", error_summary: "c" },
        { tool_name: "bash", error_summary: "d" },
        { tool_name: "bash", error_summary: "e" },
        { tool_name: "bash", error_summary: "f" },
      ]),
    );
    expect(out.length).toBe(2);
    expect(out.map((x) => x.category)).toEqual(["correction", "correction"]);
  });
});
