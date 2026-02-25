import type { Plugin } from "@opencode-ai/plugin";
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

  const checkStr = (outputStr ?? "").slice(0, 200);
  if (
    checkStr.startsWith("Error:") ||
    checkStr.startsWith("error:") ||
    checkStr.includes("ENOENT") ||
    checkStr.includes("command not found") ||
    checkStr.includes("No such file") ||
    checkStr.includes("Permission denied")
  ) {
    return true;
  }

  if (metadata && typeof metadata === "object") {
    if (typeof metadata.exit === "number" && metadata.exit !== 0) return true;
    if (typeof metadata.exitCode === "number" && metadata.exitCode !== 0) return true;
    if (metadata.success === false) return true;
    if (metadata.isError === true) return true;
  }

  return false;
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

export const MemelordPlugin: Plugin = async ({ client, directory, worktree }: any) => {
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
