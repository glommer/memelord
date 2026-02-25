import { describe, expect, test } from "bun:test";

import {
  countExplorationToolsOC,
  extractTextBlocksFromOC,
  extractToolSequencesFromOC,
  sumTokensFromOC,
} from "../../packages/cli/src/opencode/plugin-template";

describe("OpenCode plugin message helpers", () => {
  test("sumTokensFromOC counts input+output+cache.write (skips cache.read and reasoning)", () => {
    const messages: any[] = [
      {
        info: {
          role: "assistant",
          tokens: {
            input: 10,
            output: 3,
            reasoning: 999,
            cache: { read: 1000, write: 7 },
          },
        },
        parts: [],
      },
      {
        info: {
          role: "user",
          tokens: { input: 100, output: 100, cache: { read: 100, write: 100 } },
        },
        parts: [],
      },
    ];

    expect(sumTokensFromOC(messages)).toBe(20);
  });

  test("countExplorationToolsOC buckets read/grep+glob/edit+write+patch", () => {
    const seq = [
      { tool: "read" },
      { tool: "grep" },
      { tool: "glob" },
      { tool: "edit" },
      { tool: "write" },
      { tool: "patch" },
      { tool: "bash" },
    ];

    expect(countExplorationToolsOC(seq)).toEqual({ reads: 1, searches: 2, edits: 3 });
  });

  test("extractTextBlocksFromOC returns only assistant text parts > 80 chars", () => {
    const long = "a".repeat(81);
    const short = "b".repeat(80);
    const messages: any[] = [
      {
        info: { role: "assistant" },
        parts: [
          { type: "text", text: short },
          { type: "text", text: long },
          { type: "tool", tool: "read", state: { status: "completed", input: {}, output: "ok" } },
        ],
      },
      {
        info: { role: "user" },
        parts: [{ type: "text", text: long }],
      },
    ];

    expect(extractTextBlocksFromOC(messages)).toEqual([long]);
  });

  test("extractToolSequencesFromOC marks failures and skips running/pending", () => {
    const messages: any[] = [
      {
        info: { role: "assistant" },
        parts: [
          {
            type: "tool",
            tool: "read",
            state: { status: "error", input: { filePath: "/nope" }, error: "Error: File not found" },
          },
          {
            type: "tool",
            tool: "bash",
            state: {
              status: "completed",
              input: { command: "exit 1" },
              output: "boom\n",
              metadata: { exit: 1 },
            },
          },
          {
            type: "tool",
            tool: "bash",
            state: {
              status: "completed",
              input: { command: "echo ok" },
              output: "ok\n",
              metadata: { exit: 0 },
            },
          },
          {
            type: "tool",
            tool: "read",
            state: {
              status: "completed",
              input: { filePath: "/maybe" },
              output: "Error: File not found: /maybe",
              metadata: {},
            },
          },
          {
            type: "tool",
            tool: "grep",
            state: { status: "running", input: { pattern: "x" } },
          },
        ],
      },
    ];

    expect(extractToolSequencesFromOC(messages)).toEqual([
      { tool: "read", input: { filePath: "/nope" }, failed: true },
      { tool: "bash", input: { command: "exit 1" }, failed: true },
      { tool: "bash", input: { command: "echo ok" }, failed: false },
      { tool: "read", input: { filePath: "/maybe" }, failed: true },
    ]);
  });
});
