/**
 * SessionStart hook: Retrieve top memories by weight, inject as context.
 * Hot path — no embedding model, pure SQL.
 */
import { readStdin, createLightStore, getSessionsDir } from "./shared.ts";
import { writeFileSync } from "fs";
import { join } from "path";

const input = await readStdin();
const sessionId = input.session_id ?? "unknown";

const store = createLightStore(sessionId);

try {
  const memories = await store.getTopByWeight(5);

  // Record session start
  const sessionFile = join(getSessionsDir(), `${sessionId}.json`);
  writeFileSync(sessionFile, JSON.stringify({
    session_id: sessionId,
    cwd: input.cwd,
    started_at: Math.floor(Date.now() / 1000),
    injected_memory_ids: memories.map(m => m.id),
  }));

  // Build context to inject
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

  // Output for Claude Code to inject
  const output = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: context,
    },
  };

  console.log(JSON.stringify(output));
} catch (e: any) {
  // Non-blocking — write error to stderr, exit 0 so session starts normally
  console.error(`memelord SessionStart error: ${e.message}`);
} finally {
  await store.close();
}
