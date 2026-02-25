import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import type { Part, ToolPart, ToolState } from "@opencode-ai/sdk";
import { createMemoryStore, type MemoryStore, type Memory } from "memelord";
import { createEmbedder } from "memelord-embedder";
import { resolve, join } from "path";
import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, unlinkSync } from "fs";
import { spawn } from "child_process";

// Replaced by generatePluginSource() at init time
const DATA_DIR = "__DATA_DIR__";

const DISCOVERY_TOKEN_THRESHOLD = 50_000;
const PENALIZE_TOKEN_THRESHOLD = 20_000;
const EMBED_DECAY_DELAY_MS = 5 * 60 * 1000; // 5 minutes

function getDbPath(): string {
  return resolve(DATA_DIR, "memory.db");
}

function getSessionsDir(): string {
  const dir = join(DATA_DIR, "sessions");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

const dummyEmbed = async () => new Float32Array(384);

function createLightStore(sessionId: string): MemoryStore {
  return createMemoryStore({
    dbPath: getDbPath(),
    sessionId,
    embed: dummyEmbed,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function getExitCodeFromMetadata(metadata: unknown): number | null {
  if (!isRecord(metadata)) return null;

  const exit = metadata.exit;
  if (typeof exit === "number") return exit;

  const exitCode = metadata.exitCode;
  if (typeof exitCode === "number") return exitCode;

  return null;
}

export function getOpenCodeToolFailureSummaryFromState(state: ToolState): string | null {
  switch (state.status) {
    case "error": {
      return state.error;
    }
    case "completed": {
      const exit = getExitCodeFromMetadata(state.metadata);
      if (typeof exit === "number" && exit !== 0) {
        const out = state.output?.trim() ?? "";
        return out.length > 0 ? out : `Tool failed with exit code ${exit}`;
      }

      // Some tools may report failures via metadata flags.
      if (isRecord(state.metadata)) {
        if (state.metadata.success === false) return state.output;
        if (state.metadata.isError === true) return state.output;
      }

      return null;
    }
    case "pending":
    case "running": {
      return null;
    }
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

export function findToolPartByCallID(
  messages: Array<{ info: unknown; parts: Part[] }>,
  callID: string,
): ToolPart | null {
  let found: ToolPart | null = null;

  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "tool" && part.callID === callID) found = part;
    }
  }

  return found;
}

export function formatFailureEntryFromSummary(
  toolName: string,
  toolInput: any,
  errorSummary: string,
): { timestamp: number; tool_name: string; tool_input: any; error_summary: string } {
  return {
    timestamp: Math.floor(Date.now() / 1000),
    tool_name: toolName,
    tool_input: toolInput,
    error_summary: (errorSummary ?? "").slice(0, 500),
  };
}

export function buildSessionStartContext(
  memories: Array<Pick<Memory, "id" | "content" | "category" | "weight">>,
): string {
  let context = "";

  if (memories.length > 0) {
    context += "# Memories from past sessions\n\n";
    for (const mem of memories) {
      context += `[${mem.category}] (id: ${mem.id}, weight: ${mem.weight.toFixed(2)})\n${mem.content}\n\n`;
    }
  }

  // Keep this block identical to packages/cli/src/claude/hooks.ts
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

export type ToolSequenceEntry = { tool: string; input: any; failed: boolean };

export type Correction = {
  failedTool: string;
  failedInput: string;
  succeededTool: string;
  succeededInput: string;
};

export function detectCorrections(sequence: ToolSequenceEntry[]): Correction[] {
  const corrections: Correction[] = [];

  for (let i = 0; i < sequence.length - 1; i++) {
    if (!sequence[i].failed) continue;

    for (let j = i + 1; j < Math.min(i + 4, sequence.length); j++) {
      if (sequence[j].tool === sequence[i].tool && !sequence[j].failed) {
        const failedInput =
          typeof sequence[i].input === "string"
            ? sequence[i].input
            : JSON.stringify(sequence[i].input).slice(0, 200);
        const succeededInput =
          typeof sequence[j].input === "string"
            ? sequence[j].input
            : JSON.stringify(sequence[j].input).slice(0, 200);

        if (failedInput !== succeededInput) {
          corrections.push({
            failedTool: sequence[i].tool,
            failedInput,
            succeededTool: sequence[j].tool,
            succeededInput,
          });
        }

        break;
      }
    }
  }

  return corrections;
}

export function buildDiscoverySummary(texts: string[]): string | null {
  if (texts.length === 0) return null;

  const sorted = [...texts].sort((a, b) => b.length - a.length);
  const combined = new Set([...sorted.slice(0, 5), ...texts.slice(-2)]);
  const ordered = texts.filter((t) => combined.has(t));
  const summary = ordered.map((t) => t.slice(0, 500)).join("\n\n");

  if (summary.length < 100) return null;
  return summary.slice(0, 2000);
}

type FailureJsonlEntry = {
  tool_name?: unknown;
  error_summary?: unknown;
};

export function analyzeFailurePatterns(
  failuresJsonl: string,
): Array<{ content: string; category: "correction"; weight: number }> {
  const lines = failuresJsonl.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];

  const failures: Array<{ tool_name: string; error_summary: string }> = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as FailureJsonlEntry;
      if (!isRecord(parsed)) continue;

      const tool = parsed.tool_name;
      const summary = parsed.error_summary;
      if (typeof tool !== "string" || tool.length === 0) continue;
      if (typeof summary !== "string") continue;

      failures.push({ tool_name: tool, error_summary: summary });
    } catch {
      // Ignore malformed lines.
    }
  }

  if (failures.length === 0) return [];

  const counts = new Map<string, number>();
  for (const f of failures) counts.set(f.tool_name, (counts.get(f.tool_name) ?? 0) + 1);

  const result: Array<{ content: string; category: "correction"; weight: number }> = [];
  for (const [tool, count] of counts) {
    if (count < 3) continue;

    const examples = failures
      .filter((f) => f.tool_name === tool)
      .slice(0, 2)
      .map((f) => f.error_summary.slice(0, 100))
      .join("; ");

    result.push({
      content: `Repeated failures with ${tool} (${count}x in session): ${examples}`,
      category: "correction",
      weight: 1.0,
    });
  }

  return result;
}

const sessionMeta: Record<string, { injectedMemoryIds: string[]; startedAt: number }> = {};
let lastEmbedDecayPid: number | null = null;

export const MemelordPlugin: Plugin = async ({ client, directory, worktree }: PluginInput) => {
  return {
    event: async ({ event }: any) => {
      void directory;
      void worktree;

      if (!event || typeof event.type !== "string") return;

      switch (event.type) {
        case "session.created": {
          try {
            const sessionID = (event.properties as any)?.info?.id;
            if (typeof sessionID !== "string" || sessionID.length === 0) return;

            if (!existsSync(getDbPath())) return;

            const store = createLightStore(sessionID);
            try {
              const memories = await store.getTopByWeight(5);

              const startedAt = Math.floor(Date.now() / 1000);
              const injectedIds = memories.map((m) => m.id);

              const sessionFile = join(getSessionsDir(), `${sessionID}.json`);
              writeFileSync(
                sessionFile,
                JSON.stringify({
                  session_id: sessionID,
                  started_at: startedAt,
                  injected_memory_ids: injectedIds,
                }),
              );

              sessionMeta[sessionID] = { injectedMemoryIds: injectedIds, startedAt };

              const context = buildSessionStartContext(memories);
              await client.session.prompt({
                path: { id: sessionID },
                body: {
                  parts: [{ type: "text", text: context }],
                  noReply: true,
                },
              });
            } finally {
              await store.close();
            }
          } catch (e: any) {
            console.error(`memelord SessionStart error: ${e.message}`);
          }
          return;
        }
        case "session.idle": {
          // TODO(phase 5): transcript analysis + embed/decay
          void sessionMeta;
          void lastEmbedDecayPid;
          void createEmbedder;
          void DISCOVERY_TOKEN_THRESHOLD;
          void PENALIZE_TOKEN_THRESHOLD;
          void EMBED_DECAY_DELAY_MS;
          void readFileSync;
          void unlinkSync;
          void spawn;
          return;
        }
        default: {
          return;
        }
      }
    },
    "tool.execute.after": async (input: any, output: any) => {
      try {
        const toolName = input?.tool ?? "unknown";
        const sessionID = input?.sessionID ?? "unknown";
        const callID = input?.callID;

        void output;

        if (typeof callID !== "string" || callID.length === 0) return;

        const resp = await client.session.messages({
          path: { id: sessionID },
          query: { limit: 200 },
        });
        const messages = resp.data ?? [];

        const toolPart = findToolPartByCallID(messages, callID);
        if (!toolPart) return;

        const summary = getOpenCodeToolFailureSummaryFromState(toolPart.state);
        if (!summary) return;

        const entry = formatFailureEntryFromSummary(toolName, toolPart.state.input, summary);
        const failuresFile = join(getSessionsDir(), `${sessionID}.failures.jsonl`);
        appendFileSync(failuresFile, JSON.stringify(entry) + "\n");
      } catch (e: any) {
        console.error(`memelord PostToolUse error: ${e.message}`);
      }
    },
  };
};
