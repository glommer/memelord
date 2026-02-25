import { describe, expect, test } from "bun:test";

import { formatFailureEntry, isOpenCodeToolFailure } from "../packages/cli/src/opencode/plugin-template";

describe("OpenCode failure detection", () => {
  test("detects common string error prefixes", () => {
    expect(isOpenCodeToolFailure("read", "Error: File not found", {})).toBe(true);
    expect(isOpenCodeToolFailure("read", "error: something broke", null)).toBe(true);
  });

  test("detects bash non-zero exit via metadata.exit or metadata.exitCode", () => {
    expect(isOpenCodeToolFailure("bash", "", { exit: 2 })).toBe(true);
    expect(isOpenCodeToolFailure("bash", "", { exitCode: 127 })).toBe(true);
    expect(isOpenCodeToolFailure("bash", "ok", { exit: 0 })).toBe(false);
  });

  test("only checks first 200 chars of outputStr", () => {
    const longOk = "a".repeat(210) + " No such file";
    expect(isOpenCodeToolFailure("read", longOk, {})).toBe(false);
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
