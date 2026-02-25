import { describe, expect, test } from "bun:test";

import type { ToolState } from "@opencode-ai/sdk";

import {
  findToolPartByCallID,
  formatFailureEntry,
  formatFailureEntryFromSummary,
  getOpenCodeToolFailureSummaryFromState,
  isOpenCodeToolFailure,
} from "../packages/cli/src/opencode/plugin-template";

describe("OpenCode failure detection", () => {
  test("prefers ToolState.status for failure checks", () => {
    const errorState: ToolState = {
      status: "error",
      input: { filePath: "/nope" },
      error: "Error: File not found: /nope",
      time: { start: 0, end: 1 },
    };
    expect(getOpenCodeToolFailureSummaryFromState(errorState)).toContain("File not found");

    const okCompleted: ToolState = {
      status: "completed",
      input: { command: "echo ok" },
      output: "ok\n",
      title: "bash",
      metadata: { exit: 0 },
      time: { start: 0, end: 1 },
    };
    expect(getOpenCodeToolFailureSummaryFromState(okCompleted)).toBe(null);

    const badCompleted: ToolState = {
      status: "completed",
      input: { command: "exit 2" },
      output: "failed\n",
      title: "bash",
      metadata: { exit: 2 },
      time: { start: 0, end: 1 },
    };
    expect(getOpenCodeToolFailureSummaryFromState(badCompleted)).toContain("failed");
  });

  test("findToolPartByCallID finds most recent matching tool part", () => {
    const messages: any = [
      {
        info: { role: "assistant" },
        parts: [
          {
            type: "tool",
            callID: "call_1",
            tool: "read",
            state: {
              status: "error",
              input: { filePath: "/a" },
              error: "Error: nope",
              time: { start: 0, end: 1 },
            },
          },
        ],
      },
      {
        info: { role: "assistant" },
        parts: [
          {
            type: "tool",
            callID: "call_2",
            tool: "bash",
            state: {
              status: "completed",
              input: { command: "exit 1" },
              output: "",
              title: "bash",
              metadata: { exit: 1 },
              time: { start: 0, end: 1 },
            },
          },
        ],
      },
    ];

    expect(findToolPartByCallID(messages, "call_2")?.tool).toBe("bash");
    expect(findToolPartByCallID(messages, "missing")).toBe(null);
  });

  test("fallback detector still catches bash exit codes", () => {
    expect(isOpenCodeToolFailure("bash", "", { exit: 2 })).toBe(true);
    expect(isOpenCodeToolFailure("bash", "ok", { exit: 0 })).toBe(false);
  });
});

describe("formatFailureEntry", () => {
  test("prefers metadata error/message over output string", () => {
    const entry = formatFailureEntry(
      "read",
      { filePath: "/nope" },
      "Error: File not found: /nope",
      { error: "Error: File not found: /nope (from metadata)" },
    );

    expect(entry.tool_name).toBe("read");
    expect(entry.tool_input).toEqual({ filePath: "/nope" });
    expect(entry.error_summary).toContain("from metadata");
    expect(typeof entry.timestamp).toBe("number");
  });
});

describe("formatFailureEntryFromSummary", () => {
  test("uses provided summary verbatim (truncated)", () => {
    const entry = formatFailureEntryFromSummary("bash", { command: "exit 1" }, "oops");
    expect(entry.error_summary).toBe("oops");
  });
});
