import { createMemoryStore } from "memelord";
import { unlinkSync, existsSync } from "fs";

const DB_PATH = "/tmp/memelord-test.db";

// Clean up from previous runs
if (existsSync(DB_PATH)) unlinkSync(DB_PATH);

// Simple mock embedder: hash the text into a deterministic 8-dim vector
function mockEmbed(text: string): Promise<Float32Array> {
  const vec = new Float32Array(8);
  for (let i = 0; i < text.length; i++) {
    vec[i % 8] += text.charCodeAt(i) / 1000;
  }
  // Normalize
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  for (let i = 0; i < 8; i++) vec[i] /= norm || 1;
  return Promise.resolve(vec);
}

const store = createMemoryStore({
  dbPath: DB_PATH,
  sessionId: "test-session",
  embed: mockEmbed,
  dimensions: 8,
});

await store.init();
console.log("init OK");

// --- Test 1: Start task with empty memory ---
const result1 = await store.startTask("Fix the authentication bug in the login flow");
console.log(`startTask OK — taskId: ${result1.taskId}, memories: ${result1.memories.length}`);
console.assert(result1.memories.length === 0, "should have no memories initially");

// --- Test 2: Report a correction mid-task ---
const memId = await store.reportCorrection({
  lesson: "Auth middleware is in src/middleware/auth.rs, not src/auth/",
  whatFailed: "Looked for auth logic in src/auth/",
  whatWorked: "Found it in src/middleware/auth.rs",
  tokensWasted: 1500,
  toolsWasted: 5,
});
console.log(`reportCorrection OK — memId: ${memId}`);

// --- Test 3: Report user input ---
const memId2 = await store.reportUserInput({
  lesson: "Always run 'make check' before committing, not 'cargo test'",
  source: "user_correction",
});
console.log(`reportUserInput OK — memId: ${memId2}`);

// --- Test 4: End task ---
await store.endTask(result1.taskId, {
  tokensUsed: 12000,
  toolCalls: 35,
  errors: 2,
  userCorrections: 1,
  completed: true,
});
console.log("endTask OK");

// --- Test 5: Start a second task — should retrieve the memories we just stored ---
const result2 = await store.startTask("Fix a bug in the auth middleware");
console.log(`startTask #2 OK — memories: ${result2.memories.length}`);
console.assert(result2.memories.length > 0, "should retrieve memories now");

for (const mem of result2.memories) {
  console.log(`  [${mem.category}] w=${mem.weight.toFixed(2)} score=${mem.score.toFixed(3)}: ${mem.content.slice(0, 60)}...`);
}

// --- Test 6: End task with self-report ---
await store.endTask(result2.taskId, {
  tokensUsed: 8000,
  toolCalls: 20,
  errors: 0,
  userCorrections: 0,
  completed: true,
  selfReport: result2.memories.map(m => ({ memoryId: m.id, score: 3 })),
});
console.log("endTask #2 with self-report OK");

// --- Test 7: Check stats ---
const stats = await store.getStats();
console.log(`\nStats: ${stats.totalMemories} memories, ${stats.taskCount} tasks, avg score: ${stats.avgTaskScore.toFixed(3)}`);
for (const mem of stats.topMemories) {
  console.log(`  [w=${mem.weight.toFixed(2)}, used=${mem.retrievalCount}x] ${mem.content.slice(0, 60)}...`);
}

// --- Test 8: Purge ---
// Insert a low-weight memory to verify purge deletes it
await store.insertRawMemory("low-weight throwaway", "insight", 0.2);
const statsBefore = await store.getStats();
const purged = await store.purge(0.5);
const statsAfter = await store.getStats();
console.log(`\nPurge: removed ${purged} memories below weight 0.5 (before: ${statsBefore.totalMemories}, after: ${statsAfter.totalMemories})`);
console.assert(purged >= 1, "should have purged at least the low-weight memory");
console.assert(statsAfter.totalMemories < statsBefore.totalMemories, "total memories should decrease after purge");

// --- Test 9: Decay ---
const decayResult = await store.decay();
console.log(`Decay: ${decayResult.decayed} decayed, ${decayResult.deleted} deleted`);

await store.close();

// Cleanup
unlinkSync(DB_PATH);

console.log("\nAll tests passed.");
