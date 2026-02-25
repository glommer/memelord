export { MemoryStore } from "./store.js";
export type {
  EmbedFn,
  VectorType,
  MemoryCategory,
  UserInputSource,
  MemelordConfig,
  Memory,
  StartTaskResult,
  ReportCorrectionInput,
  ReportUserInput,
  SelfReportEntry,
  TaskEndInput,
  MemoryStats,
  DecayResult,
} from "./types.js";

import { MemoryStore } from "./store.js";
import type { MemelordConfig } from "./types.js";

export function createMemoryStore(config: MemelordConfig): MemoryStore {
  return new MemoryStore(config);
}
