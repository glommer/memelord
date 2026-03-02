import { existsSync, unlinkSync } from "fs";
import { join, resolve } from "path";
import type { DecayResult, EmbedFn } from "./types.js";
import { MemoryStore } from "./store.js";

export type EmbedDecayMaintenanceResult = {
  embedded: number;
  decay: DecayResult;
  cleanedSessionFile: boolean;
  cleanedFailuresFile: boolean;
};

export async function runEmbedDecayMaintenance(input: {
  sessionId: string;
  dataDir: string;
  embed: EmbedFn;
  cleanupSessionFiles?: boolean;
}): Promise<EmbedDecayMaintenanceResult> {
  const dbPath = resolve(input.dataDir, "memory.db");
  if (!existsSync(dbPath)) {
    return {
      embedded: 0,
      decay: { decayed: 0, deleted: 0 },
      cleanedSessionFile: false,
      cleanedFailuresFile: false,
    };
  }

  const store = new MemoryStore({
    dbPath,
    sessionId: input.sessionId,
    embed: input.embed,
  });

  let embedded = 0;
  let decay: DecayResult = { decayed: 0, deleted: 0 };
  try {
    await store.init();
    embedded = await store.embedPending();
    decay = await store.decay();
  } finally {
    await store.close();
  }

  let cleanedSessionFile = false;
  let cleanedFailuresFile = false;
  if (input.cleanupSessionFiles !== false) {
    try {
      const sessionsDir = join(input.dataDir, "sessions");
      const sessionFile = join(sessionsDir, `${input.sessionId}.json`);
      const failuresFile = join(sessionsDir, `${input.sessionId}.failures.jsonl`);

      if (existsSync(sessionFile)) {
        unlinkSync(sessionFile);
        cleanedSessionFile = true;
      }
      if (existsSync(failuresFile)) {
        unlinkSync(failuresFile);
        cleanedFailuresFile = true;
      }
    } catch {
      // Best-effort cleanup.
    }
  }

  return { embedded, decay, cleanedSessionFile, cleanedFailuresFile };
}
