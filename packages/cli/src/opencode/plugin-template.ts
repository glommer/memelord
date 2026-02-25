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

export function isOpenCodeToolFailure(toolName: string, outputStr: string, metadata: any): boolean {
  void toolName;

  if (metadata && typeof metadata === "object") {
    if (typeof metadata.exit === "number" && metadata.exit !== 0) return true;
    if (typeof metadata.exitCode === "number" && metadata.exitCode !== 0) return true;
    if (metadata.success === false) return true;
    if (metadata.isError === true) return true;
  }

  // Fallback: some tools surface errors only via the normalized output string.
  const checkStr = (outputStr ?? "").slice(0, 200);
  if (checkStr.startsWith("Error:") || checkStr.startsWith("error:")) return true;

  return false;
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
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = messages[i]?.parts ?? [];
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j];
      if (part.type === "tool" && part.callID === callID) return part;
    }
  }
  return null;
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

export function formatFailureEntry(
  toolName: string,
  toolInput: any,
  outputStr: string,
  metadata: any,
): { timestamp: number; tool_name: string; tool_input: any; error_summary: string } {
  const meta = metadata && typeof metadata === "object" ? metadata : null;
  const errorSummary = (meta?.error ?? meta?.message ?? outputStr ?? "").slice(0, 500);
  return {
    timestamp: Math.floor(Date.now() / 1000),
    tool_name: toolName,
    tool_input: toolInput,
    error_summary: errorSummary,
  };
}

const sessionMeta: Record<string, { injectedMemoryIds: string[]; startedAt: number }> = {};
let lastEmbedDecayPid: number | null = null;

export const MemelordPlugin: Plugin = async ({ client, directory, worktree }: PluginInput) => {
  return {
    event: async ({ event }: any) => {
      // TODO(phase 3/5): handle session.created + session.idle
      void client;
      void directory;
      void worktree;
      void event;
      void sessionMeta;
      void lastEmbedDecayPid;
      void createEmbedder;
      void DISCOVERY_TOKEN_THRESHOLD;
      void PENALIZE_TOKEN_THRESHOLD;
      void EMBED_DECAY_DELAY_MS;
      void writeFileSync;
      void readFileSync;
      void unlinkSync;
      void spawn;
    },
    "tool.execute.after": async (input: any, output: any) => {
      try {
        const toolName = input?.tool ?? "unknown";
        const sessionID = input?.sessionID ?? "unknown";
        const callID = input?.callID;

        // Prefer typesafe failure detection by looking up the ToolPart state.
        if (typeof callID === "string" && callID.length > 0) {
          const resp = await client.session.messages({
            path: { id: sessionID },
            query: { limit: 50 },
          });
          const messages = resp.data ?? [];

          const toolPart = findToolPartByCallID(messages, callID);
          if (toolPart) {
            const summary = getOpenCodeToolFailureSummaryFromState(toolPart.state);
            if (!summary) return;

            const entry = formatFailureEntryFromSummary(toolName, toolPart.state.input, summary);
            const failuresFile = join(getSessionsDir(), `${sessionID}.failures.jsonl`);
            appendFileSync(failuresFile, JSON.stringify(entry) + "\n");
            return;
          }
        }

        // Fallback: rely on normalized output + metadata from the hook.
        const toolInput = input?.args;
        const outputStr = output?.output ?? "";
        const metadata = output?.metadata;
        if (!isOpenCodeToolFailure(toolName, outputStr, metadata)) return;

        const entry = formatFailureEntry(toolName, toolInput, outputStr, metadata);
        const failuresFile = join(getSessionsDir(), `${sessionID}.failures.jsonl`);
        appendFileSync(failuresFile, JSON.stringify(entry) + "\n");
      } catch (e: any) {
        console.error(`memelord PostToolUse error: ${e.message}`);
      }
    },
  };
};
