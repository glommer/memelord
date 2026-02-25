import { describe, expect, test } from "bun:test";

import { detectCorrections, type ToolSequenceEntry } from "../../packages/cli/src/opencode/plugin-template";

describe("detectCorrections", () => {
  test("empty sequence returns empty corrections", () => {
    expect(detectCorrections([])).toEqual([]);
  });

  test("all-successful sequence returns empty", () => {
    const seq: ToolSequenceEntry[] = [
      { tool: "read", input: { filePath: "/a" }, failed: false },
      { tool: "bash", input: { command: "echo ok" }, failed: false },
    ];
    expect(detectCorrections(seq)).toEqual([]);
  });

  test("single failure with no subsequent success returns empty", () => {
    const seq: ToolSequenceEntry[] = [{ tool: "read", input: { filePath: "/nope" }, failed: true }];
    expect(detectCorrections(seq)).toEqual([]);
  });

  test("failure followed by same tool success with different input returns one correction", () => {
    const seq: ToolSequenceEntry[] = [
      { tool: "read", input: { filePath: "/a" }, failed: true },
      { tool: "read", input: { filePath: "/b" }, failed: false },
    ];
    const out = detectCorrections(seq);
    expect(out.length).toBe(1);
    expect(out[0].failedTool).toBe("read");
    expect(out[0].failedInput).toBe(JSON.stringify({ filePath: "/a" }));
    expect(out[0].succeededInput).toBe(JSON.stringify({ filePath: "/b" }));
  });

  test("failure followed by same tool success with SAME input is not a correction", () => {
    const seq: ToolSequenceEntry[] = [
      { tool: "read", input: { filePath: "/a" }, failed: true },
      { tool: "read", input: { filePath: "/a" }, failed: false },
    ];
    expect(detectCorrections(seq)).toEqual([]);
  });

  test("failure followed by DIFFERENT tool success is not a correction", () => {
    const seq: ToolSequenceEntry[] = [
      { tool: "read", input: { filePath: "/a" }, failed: true },
      { tool: "bash", input: { command: "ls" }, failed: false },
    ];
    expect(detectCorrections(seq)).toEqual([]);
  });

  test("success within 3-step lookahead window is detected", () => {
    const seq: ToolSequenceEntry[] = [
      { tool: "bash", input: { command: "exit 1" }, failed: true },
      { tool: "read", input: { filePath: "/a" }, failed: false },
      { tool: "glob", input: { pattern: "**/*.ts" }, failed: false },
      { tool: "bash", input: { command: "echo ok" }, failed: false },
    ];
    expect(detectCorrections(seq).length).toBe(1);
  });

  test("success 4 steps later is outside window and not detected", () => {
    const seq: ToolSequenceEntry[] = [
      { tool: "bash", input: { command: "exit 1" }, failed: true },
      { tool: "read", input: { filePath: "/a" }, failed: false },
      { tool: "glob", input: { pattern: "**/*.ts" }, failed: false },
      { tool: "grep", input: { pattern: "foo" }, failed: false },
      { tool: "bash", input: { command: "echo ok" }, failed: false },
    ];
    expect(detectCorrections(seq)).toEqual([]);
  });

  test("multiple corrections in one sequence are all detected", () => {
    const seq: ToolSequenceEntry[] = [
      { tool: "read", input: "wrong", failed: true },
      { tool: "read", input: "right", failed: false },
      { tool: "bash", input: "bad", failed: true },
      { tool: "bash", input: "good", failed: false },
    ];
    expect(detectCorrections(seq).length).toBe(2);
  });

  test("object inputs are JSON-stringified and truncated to 200 chars", () => {
    const longObj = { text: "a".repeat(1000) };
    const seq: ToolSequenceEntry[] = [
      { tool: "bash", input: longObj, failed: true },
      { tool: "bash", input: { text: "b" }, failed: false },
    ];
    const out = detectCorrections(seq);
    expect(out.length).toBe(1);
    expect(out[0].failedInput.length).toBe(200);
  });
});
