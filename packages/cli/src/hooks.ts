/**
 * Hook subcommands: memelord hook <event>
 *
 * These read JSON from stdin (provided by Claude Code hooks) and
 * derive the MEMELORD_DIR from the session's cwd, so each project
 * gets its own database.
 */
import { createMemoryStore, type MemoryStore } from "memelord";
import { resolve, join } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, unlinkSync } from "fs";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function readStdin(): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}

function getDataDir(cwd: string): string {
  const dir = process.env.MEMELORD_DIR ?? join(cwd, ".memelord");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function getSessionsDir(cwd: string): string {
  const dir = join(getDataDir(cwd), "sessions");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function getDbPath(cwd: string): string {
  return resolve(getDataDir(cwd), "memory.db");
}

const dummyEmbed = async () => new Float32Array(384);

function createLightStore(cwd: string, sessionId: string): MemoryStore {
  return createMemoryStore({
    dbPath: getDbPath(cwd),
    sessionId,
    embed: dummyEmbed,
  });
}

// ---------------------------------------------------------------------------
// SessionStart
// ---------------------------------------------------------------------------

async function hookSessionStart(): Promise<void> {
  const input = await readStdin();
  const sessionId = input.session_id ?? "unknown";
  const cwd = input.cwd ?? process.cwd();

  // Skip if no .memelord in this project
  if (!existsSync(join(cwd, ".memelord"))) {
    process.exit(0);
  }

  const store = createLightStore(cwd, sessionId);

  try {
    const memories = await store.getTopByWeight(5);

    const sessionFile = join(getSessionsDir(cwd), `${sessionId}.json`);
    writeFileSync(sessionFile, JSON.stringify({
      session_id: sessionId,
      cwd,
      started_at: Math.floor(Date.now() / 1000),
      injected_memory_ids: memories.map(m => m.id),
    }));

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

    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: context,
      },
    }));
  } catch (e: any) {
    console.error(`memelord SessionStart error: ${e.message}`);
  } finally {
    await store.close();
  }
}

// ---------------------------------------------------------------------------
// PostToolUse (failure recording)
// ---------------------------------------------------------------------------

async function hookPostToolUse(): Promise<void> {
  const input = await readStdin();
  const cwd = input.cwd ?? process.cwd();

  if (!existsSync(join(cwd, ".memelord"))) process.exit(0);

  const response = input.tool_response;
  if (!response) process.exit(0);

  const isFailure =
    (typeof response === "object" && response.success === false) ||
    (typeof response === "object" && response.isError === true) ||
    (typeof response === "string" && (
      response.startsWith("Error:") ||
      response.startsWith("error:") ||
      response.includes("ENOENT") ||
      response.includes("command not found") ||
      response.includes("No such file") ||
      response.includes("Permission denied")
    )) ||
    (typeof response === "object" && typeof response.exitCode === "number" && response.exitCode !== 0);

  if (!isFailure) process.exit(0);

  const sessionId = input.session_id ?? "unknown";
  const errorSummary = typeof response === "string"
    ? response.slice(0, 500)
    : (response.error ?? response.message ?? JSON.stringify(response).slice(0, 500));

  const failuresFile = join(getSessionsDir(cwd), `${sessionId}.failures.jsonl`);
  appendFileSync(failuresFile, JSON.stringify({
    timestamp: Math.floor(Date.now() / 1000),
    tool_name: input.tool_name,
    tool_input: input.tool_input,
    error_summary: errorSummary,
  }) + "\n");
}

// ---------------------------------------------------------------------------
// Stop (transcript analysis)
// ---------------------------------------------------------------------------

interface TranscriptMessage {
  role: string;
  content: any;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

function sumTokens(messages: TranscriptMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    if (msg.usage) {
      total += msg.usage.input_tokens ?? 0;
      total += msg.usage.output_tokens ?? 0;
      total += msg.usage.cache_creation_input_tokens ?? 0;
    }
  }
  return total;
}

function extractToolSequences(transcript: TranscriptMessage[]) {
  const sequence: Array<{ tool: string; input: any; failed: boolean }> = [];
  for (const msg of transcript) {
    if (!msg.content || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === "tool_use") {
        sequence.push({ tool: block.name, input: block.input, failed: false });
      }
      if (block.type === "tool_result" && sequence.length > 0) {
        const contentStr = typeof block.content === "string"
          ? block.content
          : JSON.stringify(block.content ?? "");
        const hasError = block.is_error === true ||
          contentStr.includes("Error:") ||
          contentStr.includes("ENOENT") ||
          contentStr.includes("command not found");
        sequence[sequence.length - 1].failed = hasError;
      }
    }
  }
  return sequence;
}

function detectCorrections(sequence: ReturnType<typeof extractToolSequences>) {
  const corrections: Array<{
    failedTool: string; failedInput: string;
    succeededTool: string; succeededInput: string;
  }> = [];

  for (let i = 0; i < sequence.length - 1; i++) {
    if (!sequence[i].failed) continue;
    for (let j = i + 1; j < Math.min(i + 4, sequence.length); j++) {
      if (sequence[j].tool === sequence[i].tool && !sequence[j].failed) {
        const failedInput = typeof sequence[i].input === "string"
          ? sequence[i].input : JSON.stringify(sequence[i].input).slice(0, 200);
        const succeededInput = typeof sequence[j].input === "string"
          ? sequence[j].input : JSON.stringify(sequence[j].input).slice(0, 200);
        if (failedInput !== succeededInput) {
          corrections.push({
            failedTool: sequence[i].tool, failedInput,
            succeededTool: sequence[j].tool, succeededInput,
          });
        }
        break;
      }
    }
  }
  return corrections;
}

function extractTextBlocks(messages: TranscriptMessage[]): string[] {
  const texts: string[] = [];
  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === "text" && typeof block.text === "string" && block.text.length > 80) {
        texts.push(block.text);
      }
    }
  }
  return texts;
}

async function hookStop(): Promise<void> {
  const input = await readStdin();
  const sessionId = input.session_id ?? "unknown";
  const cwd = input.cwd ?? process.cwd();
  const transcriptPath = input.transcript_path;

  if (!existsSync(join(cwd, ".memelord"))) process.exit(0);

  const store = createLightStore(cwd, sessionId);

  try {
    let correctionsFound = 0;
    let discoveryStored = false;

    let messages: TranscriptMessage[] = [];
    if (transcriptPath && existsSync(transcriptPath)) {
      const lines = readFileSync(transcriptPath, "utf-8").trim().split("\n");
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          const msg = parsed.message ?? parsed;
          if (msg.role) messages.push(msg);
        } catch {}
      }
    }

    if (messages.length > 0) {
      const sequence = extractToolSequences(messages);
      const corrections = detectCorrections(sequence);

      for (const c of corrections) {
        const content = `Auto-detected correction with ${c.failedTool}:\n\nFailed approach: ${c.failedInput}\nWorking approach: ${c.succeededInput}`;
        await store.insertRawMemory(content, "correction", 1.5);
        correctionsFound++;
      }

      // Discovery detection
      const totalTokens = sumTokens(messages);
      if (totalTokens >= 50_000) {
        const exploration = { reads: 0, searches: 0, edits: 0 };
        for (const s of sequence) {
          if (["Read", "mcp__cachebro__read_file", "mcp__cachebro__read_files"].includes(s.tool)) exploration.reads++;
          else if (["Grep", "Glob", "LSP"].includes(s.tool)) exploration.searches++;
          else if (["Edit", "Write"].includes(s.tool)) exploration.edits++;
        }
        const ratio = (exploration.reads + exploration.searches) /
          Math.max(exploration.reads + exploration.searches + exploration.edits, 1);

        if (ratio > 0.5) {
          const texts = extractTextBlocks(messages);
          if (texts.length > 0) {
            const sorted = [...texts].sort((a, b) => b.length - a.length);
            const combined = new Set([...sorted.slice(0, 5), ...texts.slice(-2)]);
            const ordered = texts.filter(t => combined.has(t));
            const summary = ordered.map(t => t.slice(0, 500)).join("\n\n").slice(0, 2000);

            if (summary.length >= 100) {
              await store.insertRawMemory(
                `[Discovery after ${Math.round(totalTokens / 1000)}k tokens, ${sequence.length} tool calls]\n\n${summary}`,
                "discovery", 1.0,
              );
              discoveryStored = true;
            }
          }
        }
      }
    }

    // Penalize injected memories when the session was expensive.
    // If we gave the agent memories and it still burned 20k+ tokens exploring,
    // those memories didn't help (or actively misled it).
    // This threshold is intentionally lower than the 50k discovery threshold —
    // discovery asks "was this exploration valuable?", penalization asks
    // "did the memories we provided actually help?"
    if (messages.length > 0) {
      const totalTokens = sumTokens(messages);
      if (totalTokens >= 20_000) {
        const sessionFile = join(getSessionsDir(cwd), `${sessionId}.json`);
        if (existsSync(sessionFile)) {
          try {
            const session = JSON.parse(readFileSync(sessionFile, "utf-8"));
            const injectedIds: string[] = session.injected_memory_ids ?? [];
            if (injectedIds.length > 0) {
              let penalized = 0;
              for (const id of injectedIds) {
                await store.penalizeMemory(id, 0.999);
                penalized++;
              }
              if (penalized > 0) {
                console.error(`memelord: penalized ${penalized} injected memories (session used ${Math.round(totalTokens / 1000)}k tokens)`);
              }
            }
          } catch {}
        }
      }
    }

    // Failure pattern detection
    const failuresFile = join(getSessionsDir(cwd), `${sessionId}.failures.jsonl`);
    if (existsSync(failuresFile)) {
      const failures = readFileSync(failuresFile, "utf-8").trim().split("\n")
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);

      const toolFailCounts = new Map<string, number>();
      for (const f of failures) toolFailCounts.set(f.tool_name, (toolFailCounts.get(f.tool_name) ?? 0) + 1);

      for (const [tool, count] of toolFailCounts) {
        if (count >= 3) {
          const examples = failures.filter((f: any) => f.tool_name === tool).slice(0, 2)
            .map((f: any) => f.error_summary.slice(0, 100)).join("; ");
          await store.insertRawMemory(`Repeated failures with ${tool} (${count}x in session): ${examples}`, "correction", 1.0);
          correctionsFound++;
        }
      }
    }

    if (correctionsFound > 0) console.error(`memelord: stored ${correctionsFound} auto-detected corrections`);
    if (discoveryStored) console.error(`memelord: stored 1 discovery from high-token exploration`);
  } catch (e: any) {
    console.error(`memelord Stop error: ${e.message}`);
  } finally {
    await store.close();
  }
}

// ---------------------------------------------------------------------------
// SessionEnd (embed pending, decay, cleanup)
// ---------------------------------------------------------------------------

async function hookSessionEnd(): Promise<void> {
  const input = await readStdin();
  const sessionId = input.session_id ?? "unknown";
  const cwd = input.cwd ?? process.cwd();

  if (!existsSync(join(cwd, ".memelord"))) process.exit(0);

  const dbPath = getDbPath(cwd);
  if (!existsSync(dbPath)) process.exit(0);

  try {
    const { createEmbedder } = await import("./embedder.js");
    const embed = await createEmbedder();

    const store = createMemoryStore({
      dbPath,
      sessionId,
      embed,
    });

    await store.init();
    const embedded = await store.embedPending();
    if (embedded > 0) console.error(`memelord: embedded ${embedded} pending memories`);

    const decayResult = await store.decay();
    if (decayResult.deleted > 0) console.error(`memelord: cleaned up ${decayResult.deleted} stale memories`);

    await store.close();

    // Clean up session files
    const sessionsDir = getSessionsDir(cwd);
    const sessionFile = join(sessionsDir, `${sessionId}.json`);
    const failuresFile = join(sessionsDir, `${sessionId}.failures.jsonl`);
    if (existsSync(sessionFile)) unlinkSync(sessionFile);
    if (existsSync(failuresFile)) unlinkSync(failuresFile);
  } catch (e: any) {
    console.error(`memelord SessionEnd error: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function runHook(event: string): Promise<void> {
  switch (event) {
    case "session-start": return hookSessionStart();
    case "post-tool-use": return hookPostToolUse();
    case "stop": return hookStop();
    case "session-end": return hookSessionEnd();
    default:
      console.error(`Unknown hook event: ${event}`);
      process.exit(1);
  }
}
