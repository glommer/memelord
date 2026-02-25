import { describe, expect, test } from "bun:test";

import { buildSessionStartContext } from "../../packages/cli/src/opencode/plugin-template";

function buildSessionStartContextCC(
  memories: Array<{ id: string; content: string; category: string; weight: number }>,
): string {
  let context = "";

  if (memories.length > 0) {
    context += "# Memories from past sessions\n\n";
    for (const mem of memories) {
      context += `[${mem.category}] (id: ${mem.id}, weight: ${mem.weight.toFixed(2)})\n${mem.content}\n\n`;
    }
  }

  context += `# Memory system instructions

You have a persistent memory system available via MCP tools. Use it:

1. At the START of every task, call memory_start_task with the user's request. This retrieves task-relevant memories using vector search (more precise than the weight-based ones above).

2. When you self-correct (tried something that failed, then found the right approach), call memory_report with type "correction".

3. When the user corrects you or shares project knowledge, call memory_report with type "user_input". The user should never have to tell you the same thing twice.

4. When you discover something useful about the codebase (key file locations, architecture patterns, build/test conventions), call memory_report with type "insight". This saves future sessions from re-exploring the same codebase.

5. IMPORTANT — Before finishing a task, review the memories above against what you actually found. If any memory contains incorrect information (wrong file paths, wrong function names, wrong explanations), you MUST call memory_contradict with its id to remove it. Provide the correct information so future sessions get it right. Bad memories poison every future session if not removed.

6. When you finish a task, call memory_end_task with outcome metrics and rate each retrieved memory (0=ignored, 1=glanced, 2=useful, 3=directly applied).`;

  return context;
}

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

  test("instructions mention all 6 memory tools", () => {
    const out = buildSessionStartContext([]);
    expect(out.includes("memory_start_task")).toBe(true);
    expect(out.includes("memory_report")).toBe(true);
    expect(out.includes("memory_contradict")).toBe(true);
    expect(out.includes("memory_end_task")).toBe(true);

    // Spot-check the numbered items to ensure formatting stays stable.
    expect(out.includes("1. At the START of every task")).toBe(true);
    expect(out.includes("2. When you self-correct")).toBe(true);
    expect(out.includes("3. When the user corrects you")).toBe(true);
    expect(out.includes("4. When you discover something useful")).toBe(true);
    expect(out.includes("5. IMPORTANT — Before finishing a task")).toBe(true);
    expect(out.includes("6. When you finish a task")).toBe(true);
  });

  test("output matches Claude Code context builder for same inputs", () => {
    const memories = [
      { id: "a", category: "insight", content: "one", weight: 2.0 },
      { id: "b", category: "correction", content: "two", weight: 0.25 },
    ];
    expect(buildSessionStartContext(memories as any)).toBe(buildSessionStartContextCC(memories));
  });
});
