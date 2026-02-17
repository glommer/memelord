import { createMemoryStore, type MemoryStore } from "memelord";
import { resolve, join } from "path";
import { existsSync, mkdirSync } from "fs";

/** Working directory, set from hook stdin or fallback to process.cwd(). */
let _cwd: string | undefined;

export function setCwd(cwd: string): void {
  _cwd = cwd;
}

export function getDataDir(): string {
  // Explicit env wins, then derive from working directory
  const dir = process.env.MEMELORD_DIR ?? join(_cwd ?? process.cwd(), ".memelord");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function getSessionsDir(): string {
  const dir = join(getDataDir(), "sessions");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function getDbPath(): string {
  return resolve(getDataDir(), "memory.db");
}

export async function readStdin(): Promise<any> {
  const text = await Bun.stdin.text();
  const input = JSON.parse(text);
  // Hooks receive cwd from Claude Code — use it to find the right per-directory DB
  if (input.cwd) {
    setCwd(input.cwd);
  }
  return input;
}

const dummyEmbed = async () => new Float32Array(384);

/** Create a store that doesn't need the embedding model (for fast hooks). */
export function createLightStore(sessionId: string): MemoryStore {
  return createMemoryStore({
    dbPath: getDbPath(),
    sessionId,
    embed: dummyEmbed,
  });
}
