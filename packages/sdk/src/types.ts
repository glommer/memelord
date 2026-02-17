/** User-provided embedding function. Takes text, returns a vector. */
export type EmbedFn = (text: string) => Promise<Float32Array>;

/** Turso vector type for distance calculations. Easy to swap for experimentation. */
export type VectorType = "vector32" | "vector64" | "vector8" | "vector1";

export type MemoryCategory = "correction" | "insight" | "user" | "consolidated" | "discovery";

export type UserInputSource = "user_denial" | "user_correction" | "user_input";

export interface MemelordConfig {
  /** Path to the Turso database file */
  dbPath: string;
  /** Session identifier — each agent session gets its own ID */
  sessionId: string;
  /** Embedding function — SDK users provide their own */
  embed: EmbedFn;
  /** Vector type for distance calculations (default: "vector32") */
  vectorType?: VectorType;
  /** Embedding dimensions (default: 384) */
  dimensions?: number;
  /** Number of memories to retrieve per task (default: 5) */
  topK?: number;
  /** EMA learning rate for weight updates (default: 0.1) */
  learningRate?: number;
  /** Daily decay rate for unused memories (default: 0.995) */
  decayRate?: number;
}

export interface Memory {
  id: string;
  content: string;
  category: MemoryCategory;
  weight: number;
  /** Retrieval score: cosine similarity (0-1) */
  score: number;
  createdAt: number;
  retrievalCount: number;
}

export interface StartTaskResult {
  taskId: string;
  memories: Memory[];
}

export interface ReportCorrectionInput {
  /** The lesson learned */
  lesson: string;
  /** What approach failed */
  whatFailed: string;
  /** What approach worked */
  whatWorked: string;
  /** Approximate tokens spent on the wrong approach */
  tokensWasted?: number;
  /** Number of tool calls wasted on the wrong approach */
  toolsWasted?: number;
}

export interface ReportUserInput {
  /** The lesson / knowledge from the user */
  lesson: string;
  /** How the user provided this */
  source: UserInputSource;
}

export interface SelfReportEntry {
  memoryId: string;
  /** 0 = ignored, 1 = glanced, 2 = somewhat useful, 3 = directly applied */
  score: number;
}

export interface TaskEndInput {
  tokensUsed: number;
  toolCalls: number;
  errors: number;
  userCorrections: number;
  completed: boolean;
  selfReport?: SelfReportEntry[];
}

export interface MemoryStats {
  totalMemories: number;
  taskCount: number;
  avgTaskScore: number;
  topMemories: Array<{ content: string; weight: number; retrievalCount: number }>;
}

export interface DecayResult {
  decayed: number;
  deleted: number;
}

/** Running baseline for z-score computation */
export interface TaskBaseline {
  count: number;
  meanTokens: number;
  meanErrors: number;
  meanUserCorrections: number;
  m2Tokens: number;
  m2Errors: number;
  m2UserCorrections: number;
}
