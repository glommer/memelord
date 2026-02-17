/**
 * SessionEnd hook: Batch-embed pending memories, run decay, clean up.
 * Cold path — loads the embedding model (acceptable since session is ending).
 */
import { readStdin, getDataDir, getSessionsDir } from "./shared.ts";
import { createMemoryStore } from "memelord";
import { createEmbedder } from "../packages/cli/src/embedder.ts";
import { resolve, join } from "path";
import { existsSync, unlinkSync } from "fs";

const input = await readStdin();
const sessionId = input.session_id ?? "unknown";

const dataDir = getDataDir();
const dbPath = resolve(dataDir, "memory.db");

if (!existsSync(dbPath)) {
  // No database yet — nothing to do
  process.exit(0);
}

try {
  // Load real embedding model (cold start OK — session is ending)
  const embed = await createEmbedder();

  const store = createMemoryStore({
    dbPath,
    sessionId,
    embed,
  });

  await store.init();

  // Embed all memories that were stored without embeddings (by hooks)
  const embedded = await store.embedPending();
  if (embedded > 0) {
    console.error(`memelord: embedded ${embedded} pending memories`);
  }

  // Run decay pass
  const decayResult = await store.decay();
  if (decayResult.deleted > 0) {
    console.error(`memelord: cleaned up ${decayResult.deleted} stale memories`);
  }

  await store.close();

  // Clean up session files
  const sessionsDir = getSessionsDir();
  const sessionFile = join(sessionsDir, `${sessionId}.json`);
  const failuresFile = join(sessionsDir, `${sessionId}.failures.jsonl`);

  if (existsSync(sessionFile)) unlinkSync(sessionFile);
  if (existsSync(failuresFile)) unlinkSync(failuresFile);
} catch (e: any) {
  console.error(`memelord SessionEnd error: ${e.message}`);
}
