/**
 * Example: using memelord as an SDK.
 *
 * The SDK has no model dependency — you bring your own embedding function.
 * This example uses @huggingface/transformers for local embeddings.
 */
import { createMemoryStore } from "memelord";
import { pipeline } from "@huggingface/transformers";

// 1. Create an embedding function using any model you like
const extractor = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
  quantized: true,
});

async function embed(text: string): Promise<Float32Array> {
  const output = await extractor(text, { pooling: "mean", normalize: true });
  return new Float32Array(output.data as Float64Array);
}

// 2. Create a memory store
const store = createMemoryStore({
  dbPath: ".memelord/memory.db",
  sessionId: "my-agent-session-1",
  embed,
});

await store.init();

// 3. Start a task — retrieves relevant memories from past sessions
const { taskId, memories } = await store.startTask("Fix the auth middleware bug");

for (const mem of memories) {
  console.log(`[${mem.category}] score=${mem.score.toFixed(3)}: ${mem.content}`);
}

// 4. Report a correction when you self-correct mid-task
await store.reportCorrection({
  lesson: "Auth middleware is in src/middleware/auth.rs, not src/auth/",
  whatFailed: "Looked for auth logic in src/auth/",
  whatWorked: "Found it in src/middleware/auth.rs",
  tokensWasted: 1500,
});

// 5. Report user-provided knowledge
await store.reportUserInput({
  lesson: "Always run 'make check' before committing",
  source: "user_correction",
});

// 6. End the task — rate each retrieved memory so the system learns
await store.endTask(taskId, {
  tokensUsed: 12000,
  toolCalls: 35,
  errors: 2,
  userCorrections: 1,
  completed: true,
  selfReport: memories.map((m) => ({ memoryId: m.id, score: 3 })),
});

// 7. Embed any memories that were stored without embeddings
await store.embedPending();

await store.close();
