import { connect } from "@tursodatabase/database";
import { randomUUID } from "crypto";
import type {
  MemelordConfig,
  Memory,
  MemoryCategory,
  StartTaskResult,
  ReportCorrectionInput,
  ReportUserInput,
  TaskEndInput,
  MemoryStats,
  DecayResult,
  TaskBaseline,
  VectorType,
} from "./types.js";
import {
  computeTaskScore,
  computeCredit,
  updateWeight,
  initialWeight,
  updateBaseline,
  emptyBaseline,
} from "./scoring.js";

type Database = Awaited<ReturnType<typeof connect>>;

/** Turso driver truncates Float32Array to 1 byte/element. Wrap as Buffer to preserve float32 binary data. */
function vecBuf(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
    id              TEXT PRIMARY KEY,
    content         TEXT NOT NULL,
    embedding       BLOB,
    category        TEXT NOT NULL,
    weight          REAL DEFAULT 1.0,
    initial_cost    INTEGER DEFAULT 0,
    created_at      INTEGER NOT NULL,
    last_retrieved  INTEGER,
    retrieval_count INTEGER DEFAULT 0,
    source_task     TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
    id               TEXT PRIMARY KEY,
    description      TEXT,
    embedding        BLOB,
    tokens_used      INTEGER,
    tool_calls       INTEGER,
    errors           INTEGER,
    user_corrections INTEGER,
    completed        INTEGER,
    task_score       REAL,
    started_at       INTEGER,
    finished_at      INTEGER
);

CREATE TABLE IF NOT EXISTS memory_retrievals (
    memory_id   TEXT,
    task_id     TEXT,
    similarity  REAL,
    self_report REAL,
    credit      REAL,
    PRIMARY KEY (memory_id, task_id)
);

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
`;

export class MemoryStore {
  private initialized = false;
  private currentTaskId: string | null = null;
  private baseline: TaskBaseline = emptyBaseline();

  private readonly dbPath: string;
  private readonly sessionId: string;
  private readonly embed: MemelordConfig["embed"];
  private readonly vectorType: VectorType;
  private readonly topK: number;
  private readonly learningRate: number;
  private readonly decayRate: number;

  constructor(config: MemelordConfig) {
    this.dbPath = config.dbPath;
    this.sessionId = config.sessionId;
    this.embed = config.embed;
    this.vectorType = config.vectorType ?? "vector32";
    this.topK = config.topK ?? 5;
    this.learningRate = config.learningRate ?? 0.1;
    this.decayRate = config.decayRate ?? 0.995;
  }

  /**
   * Open a short-lived connection, execute fn, then close.
   * Turso's embedded driver locks the file at connect() time and is not
   * multi-process safe with long-lived connections. We:
   * 1. Open/close per operation so the lock is held briefly
   * 2. Retry connect() with backoff if another process holds the lock
   */
  private async withDb<T>(fn: (db: Database) => Promise<T>): Promise<T> {
    const maxRetries = 10;
    const baseDelay = 50; // ms

    let db: Database;
    for (let attempt = 0; ; attempt++) {
      try {
        db = await connect(this.dbPath);
        break;
      } catch (e: any) {
        if (attempt >= maxRetries || !e.message?.includes("locked") && !e.message?.includes("Locking")) {
          throw e;
        }
        const delay = baseDelay * (1 + Math.random()) * Math.min(attempt + 1, 5);
        await new Promise(r => setTimeout(r, delay));
      }
    }

    await db.exec("PRAGMA busy_timeout = 5000");
    try {
      return await fn(db);
    } finally {
      db.close();
    }
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.withDb(async (db) => {
      await db.exec(SCHEMA);
      // One-time migration: detect embeddings truncated by Float32Array driver bug
      const result = await db.prepare(
        "UPDATE memories SET embedding = NULL WHERE embedding IS NOT NULL AND length(embedding) < 1536"
      ).run();
      if (result.changes > 0) {
        console.error(`[memelord] Fixed ${result.changes} truncated embeddings (will re-embed on next startTask)`);
      }
      // Load baseline
      const row = await db.prepare("SELECT value FROM meta WHERE key = 'baseline'").get() as { value: string } | undefined;
      if (row) {
        this.baseline = JSON.parse(row.value);
      }
    });
    this.initialized = true;
  }

  /** The SQL function name for the configured vector type */
  private get vfn(): string {
    return this.vectorType;
  }

  // ---------------------------------------------------------------------------
  // Task lifecycle
  // ---------------------------------------------------------------------------

  async startTask(description: string): Promise<StartTaskResult> {
    await this.init();
    const taskId = randomUUID();
    const now = Math.floor(Date.now() / 1000);

    // Embed the task description (outside withDb — no lock during model inference)
    const taskEmbedding = await this.embed(description);

    // Embed any pending memories first (has its own withDb calls)
    await this.embedPending();

    const memories = await this.withDb(async (db) => {
      // Insert task record
      await db.prepare(
        "INSERT INTO tasks (id, description, embedding, started_at) VALUES (?, ?, ?, ?)"
      ).run(taskId, description, vecBuf(taskEmbedding), now);

      // Retrieve top-k memories by relevance (similarity * recency).
      // Weight is intentionally excluded: it captures historical usefulness
      // across all tasks, which is orthogonal to relevance for THIS task.
      const vfn = this.vfn;
      const rows = await db.prepare(`
        SELECT
          id, content, category, weight, created_at, retrieval_count,
          vector_distance_cos(${vfn}(embedding), ${vfn}(?)) AS distance
        FROM memories
        WHERE embedding IS NOT NULL
        ORDER BY
          (1.0 - vector_distance_cos(${vfn}(embedding), ${vfn}(?)))
          * POWER(?, (CAST(? AS REAL) - COALESCE(last_retrieved, created_at)) / 86400.0)
        DESC
        LIMIT ?
      `).all(vecBuf(taskEmbedding), vecBuf(taskEmbedding), this.decayRate, now, this.topK) as any[];

      const mems: Memory[] = rows.map((r: any) => ({
        id: r.id,
        content: r.content,
        category: r.category,
        weight: r.weight,
        score: 1.0 - r.distance,
        createdAt: r.created_at,
        retrievalCount: r.retrieval_count,
      }));

      // Record retrievals
      for (const mem of mems) {
        await db.prepare(
          "INSERT OR IGNORE INTO memory_retrievals (memory_id, task_id, similarity) VALUES (?, ?, ?)"
        ).run(mem.id, taskId, mem.score);

        await db.prepare(
          "UPDATE memories SET last_retrieved = ?, retrieval_count = retrieval_count + 1 WHERE id = ?"
        ).run(now, mem.id);
      }

      return mems;
    });

    this.currentTaskId = taskId;
    return { taskId, memories };
  }

  async reportCorrection(input: ReportCorrectionInput): Promise<string> {
    await this.init();
    const id = randomUUID();
    const now = Math.floor(Date.now() / 1000);

    const content = `${input.lesson}\n\nFailed approach: ${input.whatFailed}\nWorking approach: ${input.whatWorked}`;
    // Embed outside withDb — no lock during model inference
    const embedding = await this.embed(content);

    await this.withDb(async (db) => {
      const avgRow = await db.prepare(
        "SELECT AVG(tokens_used) as avg FROM tasks WHERE tokens_used IS NOT NULL"
      ).get() as { avg: number | null } | undefined;
      const avgTokens = avgRow?.avg ?? 10000;

      const weight = initialWeight("correction", undefined, input.tokensWasted, avgTokens);

      await db.prepare(
        "INSERT INTO memories (id, content, embedding, category, weight, initial_cost, created_at, source_task) VALUES (?, ?, ?, 'correction', ?, ?, ?, ?)"
      ).run(id, content, vecBuf(embedding), weight, input.tokensWasted ?? 0, now, this.currentTaskId);
    });

    return id;
  }

  async reportUserInput(input: ReportUserInput): Promise<string> {
    await this.init();
    const id = randomUUID();
    const now = Math.floor(Date.now() / 1000);

    // Embed outside withDb
    const embedding = await this.embed(input.lesson);
    const weight = initialWeight("user", input.source);

    await this.withDb(async (db) => {
      await db.prepare(
        "INSERT INTO memories (id, content, embedding, category, weight, created_at, source_task) VALUES (?, ?, ?, 'user', ?, ?, ?)"
      ).run(id, input.lesson, vecBuf(embedding), weight, now, this.currentTaskId);
    });

    return id;
  }

  async endTask(taskId: string, input: TaskEndInput): Promise<void> {
    await this.init();
    const now = Math.floor(Date.now() / 1000);

    const taskScore = computeTaskScore(
      this.baseline,
      input.tokensUsed,
      input.errors,
      input.userCorrections,
      input.completed,
    );

    this.baseline = updateBaseline(this.baseline, input.tokensUsed, input.errors, input.userCorrections);

    await this.withDb(async (db) => {
      await db.prepare(`
        UPDATE tasks SET
          tokens_used = ?, tool_calls = ?, errors = ?,
          user_corrections = ?, completed = ?, task_score = ?, finished_at = ?
        WHERE id = ?
      `).run(
        input.tokensUsed, input.toolCalls, input.errors,
        input.userCorrections, input.completed ? 1 : 0, taskScore, now,
        taskId,
      );

      // Save baseline
      await db.prepare(
        "INSERT INTO meta (key, value) VALUES ('baseline', ?) ON CONFLICT(key) DO UPDATE SET value = ?"
      ).run(JSON.stringify(this.baseline), JSON.stringify(this.baseline));

      // Process self-report: update weights for retrieved memories
      if (input.selfReport && input.selfReport.length > 0) {
        const numRetrieved = input.selfReport.length;

        for (const entry of input.selfReport) {
          const credit = computeCredit(taskScore, entry.score, numRetrieved);

          const memRow = await db.prepare(
            "SELECT weight FROM memories WHERE id = ?"
          ).get(entry.memoryId) as { weight: number } | undefined;

          if (memRow) {
            const newWeight = updateWeight(memRow.weight, credit, this.learningRate);
            await db.prepare("UPDATE memories SET weight = ? WHERE id = ?").run(newWeight, entry.memoryId);
          }

          await db.prepare(
            "UPDATE memory_retrievals SET self_report = ?, credit = ? WHERE memory_id = ? AND task_id = ?"
          ).run(entry.score, credit, entry.memoryId, taskId);
        }
      }
    });

    if (this.currentTaskId === taskId) {
      this.currentTaskId = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Maintenance
  // ---------------------------------------------------------------------------

  async decay(): Promise<DecayResult> {
    await this.init();
    return this.withDb(async (db) => {
      const decayResult = await db.prepare(
        "UPDATE memories SET weight = weight * ?"
      ).run(this.decayRate);

      const deleteResult = await db.prepare(
        "DELETE FROM memories WHERE weight < 0.15 AND retrieval_count > 5"
      ).run();

      return {
        decayed: decayResult.changes,
        deleted: deleteResult.changes,
      };
    });
  }

  async purge(threshold: number): Promise<number> {
    await this.init();
    return this.withDb(async (db) => {
      const result = await db.prepare(
        "DELETE FROM memories WHERE weight < ?"
      ).run(threshold);
      return result.changes;
    });
  }

  async getStats(): Promise<MemoryStats> {
    await this.init();
    return this.withDb(async (db) => {
      const memCount = await db.prepare("SELECT COUNT(*) as c FROM memories").get() as { c: number };
      const taskCount = await db.prepare("SELECT COUNT(*) as c FROM tasks").get() as { c: number };
      const avgScore = await db.prepare(
        "SELECT AVG(task_score) as avg FROM tasks WHERE task_score IS NOT NULL"
      ).get() as { avg: number | null };

      const topRows = await db.prepare(
        "SELECT content, weight, retrieval_count FROM memories ORDER BY weight DESC LIMIT 10"
      ).all() as any[];

      return {
        totalMemories: memCount.c,
        taskCount: taskCount.c,
        avgTaskScore: avgScore.avg ?? 0,
        topMemories: topRows.map((r: any) => ({
          content: r.content,
          weight: r.weight,
          retrievalCount: r.retrieval_count,
        })),
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Hook-oriented methods (no embedding model required for get/insert)
  // ---------------------------------------------------------------------------

  async getTopByWeight(limit: number = 5): Promise<Memory[]> {
    await this.init();
    return this.withDb(async (db) => {
      const rows = await db.prepare(`
        SELECT id, content, category, weight, created_at, retrieval_count
        FROM memories
        ORDER BY weight DESC
        LIMIT ?
      `).all(limit) as any[];

      return rows.map((r: any) => ({
        id: r.id,
        content: r.content,
        category: r.category,
        weight: r.weight,
        score: r.weight,
        createdAt: r.created_at,
        retrievalCount: r.retrieval_count,
      }));
    });
  }

  async insertRawMemory(content: string, category: MemoryCategory, weight: number): Promise<string> {
    await this.init();
    const id = randomUUID();
    const now = Math.floor(Date.now() / 1000);

    await this.withDb(async (db) => {
      await db.prepare(
        "INSERT INTO memories (id, content, embedding, category, weight, created_at, source_task) VALUES (?, ?, NULL, ?, ?, ?, ?)"
      ).run(id, content, category, weight, now, this.currentTaskId);
    });

    return id;
  }

  async embedPending(): Promise<number> {
    await this.init();

    // Read pending list with a short-lived connection
    const rows = await this.withDb(async (db) => {
      return await db.prepare(
        "SELECT id, content FROM memories WHERE embedding IS NULL"
      ).all() as any[];
    });

    if (rows.length === 0) return 0;

    // Embed each (no DB lock held during model inference)
    const embedded: Array<{ id: string; embedding: Buffer }> = [];
    for (const row of rows) {
      const vec = await this.embed(row.content);
      embedded.push({ id: row.id, embedding: vecBuf(vec) });
    }

    // Write all embeddings back in one short connection
    await this.withDb(async (db) => {
      for (const e of embedded) {
        await db.prepare("UPDATE memories SET embedding = ? WHERE id = ?").run(e.embedding, e.id);
      }
    });

    return rows.length;
  }

  async contradictMemory(
    memoryId: string,
    correction?: string,
  ): Promise<{ deleted: boolean; correctionId?: string }> {
    await this.init();

    const deleted = await this.withDb(async (db) => {
      const result = await db.prepare("DELETE FROM memories WHERE id = ?").run(memoryId);
      await db.prepare("DELETE FROM memory_retrievals WHERE memory_id = ?").run(memoryId);
      return result.changes > 0;
    });

    let correctionId: string | undefined;
    if (correction && deleted) {
      const embedding = await this.embed(correction);
      const id = randomUUID();
      const now = Math.floor(Date.now() / 1000);
      await this.withDb(async (db) => {
        await db.prepare(
          "INSERT INTO memories (id, content, embedding, category, weight, created_at, source_task) VALUES (?, ?, ?, 'correction', 2.0, ?, ?)"
        ).run(id, correction, vecBuf(embedding), now, this.currentTaskId);
      });
      correctionId = id;
    }

    return { deleted, correctionId };
  }

  async penalizeMemory(memoryId: string, factor: number): Promise<void> {
    await this.init();
    await this.withDb(async (db) => {
      await db.prepare(
        "UPDATE memories SET weight = MAX(weight * ?, 0.1) WHERE id = ?"
      ).run(factor, memoryId);
    });
  }

  async close(): Promise<void> {
    // No persistent connection to close — withDb opens/closes per operation.
    this.initialized = false;
  }
}
