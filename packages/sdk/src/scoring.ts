import type { TaskBaseline, MemoryCategory, UserInputSource } from "./types.js";

/**
 * Welford's online algorithm for updating running mean and variance.
 * Returns a new baseline (does not mutate).
 */
export function updateBaseline(
  baseline: TaskBaseline,
  tokens: number,
  errors: number,
  userCorrections: number,
): TaskBaseline {
  const n = baseline.count + 1;
  const dTokens = tokens - baseline.meanTokens;
  const dErrors = errors - baseline.meanErrors;
  const dUserCorr = userCorrections - baseline.meanUserCorrections;

  const meanTokens = baseline.meanTokens + dTokens / n;
  const meanErrors = baseline.meanErrors + dErrors / n;
  const meanUserCorrections = baseline.meanUserCorrections + dUserCorr / n;

  return {
    count: n,
    meanTokens,
    meanErrors,
    meanUserCorrections,
    m2Tokens: baseline.m2Tokens + dTokens * (tokens - meanTokens),
    m2Errors: baseline.m2Errors + dErrors * (errors - meanErrors),
    m2UserCorrections: baseline.m2UserCorrections + dUserCorr * (userCorrections - meanUserCorrections),
  };
}

function stddev(m2: number, count: number): number {
  if (count < 2) return 1; // avoid division by zero; return 1 so z-score = raw delta
  return Math.sqrt(m2 / (count - 1)) || 1;
}

/**
 * Compute a composite task score using z-scores against the running baseline.
 * Positive = better than average, negative = worse.
 *
 * For cold start (<10 tasks), uses simple normalized deltas instead of z-scores.
 */
export function computeTaskScore(
  baseline: TaskBaseline,
  tokens: number,
  errors: number,
  userCorrections: number,
  completed: boolean,
): number {
  const completedSignal = completed ? 1 : -1;

  if (baseline.count < 10) {
    // Cold start: simple heuristic scoring
    // Lower tokens/errors = better, completed = good
    const tokenDelta = baseline.count > 0
      ? (baseline.meanTokens - tokens) / Math.max(baseline.meanTokens, 1)
      : 0;
    const errorDelta = baseline.count > 0
      ? (baseline.meanErrors - errors) / Math.max(baseline.meanErrors, 1)
      : 0;
    return tokenDelta + errorDelta - userCorrections * 0.5 + completedSignal;
  }

  // Z-score based scoring: negative z means "below average" which is GOOD for tokens/errors
  const zTokens = (tokens - baseline.meanTokens) / stddev(baseline.m2Tokens, baseline.count);
  const zErrors = (errors - baseline.meanErrors) / stddev(baseline.m2Errors, baseline.count);
  const zUserCorr = (userCorrections - baseline.meanUserCorrections) / stddev(baseline.m2UserCorrections, baseline.count);

  return -zTokens - zErrors - zUserCorr + completedSignal;
}

/**
 * Compute credit for a single memory based on task outcome and self-report.
 */
export function computeCredit(
  taskScore: number,
  selfReportScore: number,
  numMemoriesRetrieved: number,
): number {
  return taskScore * (selfReportScore / 3.0) * (1.0 / Math.max(numMemoriesRetrieved, 1));
}

/**
 * Update a memory's weight using exponential moving average.
 * Clamped to [0.1, 5.0] to prevent extremes.
 */
export function updateWeight(
  oldWeight: number,
  credit: number,
  learningRate: number,
): number {
  const raw = (1 - learningRate) * oldWeight + learningRate * credit;
  return Math.max(0.1, Math.min(5.0, raw));
}

/**
 * Compute initial weight for a new memory based on its source.
 */
export function initialWeight(
  category: MemoryCategory,
  source?: UserInputSource,
  tokensWasted?: number,
  avgTokensPerTask?: number,
): number {
  switch (category) {
    case "correction": {
      const avg = avgTokensPerTask || 10000;
      const cost = tokensWasted || 0;
      return 1.0 + (cost / avg);
    }
    case "user": {
      switch (source) {
        case "user_denial": return 2.0;
        case "user_correction": return 2.5;
        case "user_input": return 2.0;
        default: return 2.0;
      }
    }
    case "insight": return 1.0;
    case "consolidated": return 1.0; // set to avg of sources by caller
    default: return 1.0;
  }
}

/**
 * Create a fresh (empty) baseline for z-score tracking.
 */
export function emptyBaseline(): TaskBaseline {
  return {
    count: 0,
    meanTokens: 0,
    meanErrors: 0,
    meanUserCorrections: 0,
    m2Tokens: 0,
    m2Errors: 0,
    m2UserCorrections: 0,
  };
}
