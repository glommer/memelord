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
      // TODO(phase 4): detect + record failures to sessions/<id>.failures.jsonl
      void input;
      void output;
      void appendFileSync;
      void getSessionsDir;
    },
  };
};
