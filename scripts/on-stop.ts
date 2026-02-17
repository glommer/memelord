/**
 * Stop hook: Analyze transcript for self-correction patterns and expensive
 * exploration discoveries. Stores findings as raw memories (no embedding).
 */
import { readStdin, createLightStore, getSessionsDir } from "./shared.ts";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const DISCOVERY_TOKEN_THRESHOLD = 50_000;

interface FailureEntry {
  timestamp: number;
  tool_name: string;
  tool_input: any;
  error_summary: string;
}

interface TranscriptMessage {
  role: string;
  content: any;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

function extractToolSequences(transcript: TranscriptMessage[]): Array<{
  tool: string;
  input: any;
  failed: boolean;
}> {
  const sequence: Array<{ tool: string; input: any; failed: boolean }> = [];

  for (const msg of transcript) {
    if (!msg.content || !Array.isArray(msg.content)) continue;

    for (const block of msg.content) {
      if (block.type === "tool_use") {
        sequence.push({
          tool: block.name,
          input: block.input,
          failed: false,
        });
      }
      if (block.type === "tool_result" && sequence.length > 0) {
        const contentStr = typeof block.content === "string"
          ? block.content
          : JSON.stringify(block.content ?? "");
        const hasError = block.is_error === true ||
          contentStr.includes("Error:") ||
          contentStr.includes("ENOENT") ||
          contentStr.includes("command not found");
        sequence[sequence.length - 1].failed = hasError;
      }
    }
  }

  return sequence;
}

function detectCorrections(sequence: Array<{ tool: string; input: any; failed: boolean }>): Array<{
  failedTool: string;
  failedInput: string;
  succeededTool: string;
  succeededInput: string;
}> {
  const corrections: Array<{
    failedTool: string;
    failedInput: string;
    succeededTool: string;
    succeededInput: string;
  }> = [];

  for (let i = 0; i < sequence.length - 1; i++) {
    if (!sequence[i].failed) continue;

    for (let j = i + 1; j < Math.min(i + 4, sequence.length); j++) {
      if (sequence[j].tool === sequence[i].tool && !sequence[j].failed) {
        const failedInput = typeof sequence[i].input === "string"
          ? sequence[i].input
          : JSON.stringify(sequence[i].input).slice(0, 200);
        const succeededInput = typeof sequence[j].input === "string"
          ? sequence[j].input
          : JSON.stringify(sequence[j].input).slice(0, 200);

        if (failedInput !== succeededInput) {
          corrections.push({
            failedTool: sequence[i].tool,
            failedInput,
            succeededTool: sequence[j].tool,
            succeededInput,
          });
        }
        break;
      }
    }
  }

  return corrections;
}

// ---------------------------------------------------------------------------
// Discovery detection: expensive exploration without corrections
// ---------------------------------------------------------------------------

function sumTokens(messages: TranscriptMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    if (msg.usage) {
      // cache_creation_input_tokens = new unique content processed per turn
      // output_tokens = model generation
      // input_tokens = non-cached input (usually small)
      // DO NOT count cache_read_input_tokens — it re-counts the entire
      // context each turn and grows quadratically.
      total += msg.usage.input_tokens ?? 0;
      total += msg.usage.output_tokens ?? 0;
      total += msg.usage.cache_creation_input_tokens ?? 0;
    }
  }
  return total;
}

function extractTextBlocks(messages: TranscriptMessage[]): string[] {
  const texts: string[] = [];
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    if (!msg.content || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === "text" && typeof block.text === "string" && block.text.length > 80) {
        texts.push(block.text);
      }
    }
  }
  return texts;
}

function countExplorationTools(sequence: Array<{ tool: string; input: any; failed: boolean }>): {
  reads: number;
  searches: number;
  edits: number;
} {
  let reads = 0, searches = 0, edits = 0;
  for (const s of sequence) {
    if (s.tool === "Read" || s.tool === "mcp__cachebro__read_file" || s.tool === "mcp__cachebro__read_files") reads++;
    else if (s.tool === "Grep" || s.tool === "Glob" || s.tool === "LSP") searches++;
    else if (s.tool === "Edit" || s.tool === "Write") edits++;
  }
  return { reads, searches, edits };
}

function buildDiscoverySummary(texts: string[]): string | null {
  if (texts.length === 0) return null;

  // Take the longest text blocks — these are where the agent explains
  // what it found/learned, not short transitional phrases
  const sorted = [...texts].sort((a, b) => b.length - a.length);
  const topBlocks = sorted.slice(0, 5);

  // Also include the last 2 blocks (agents often summarize at the end)
  const lastBlocks = texts.slice(-2);
  const combined = new Set([...topBlocks, ...lastBlocks]);

  // Rebuild in original order
  const ordered = texts.filter(t => combined.has(t));
  const summary = ordered.map(t => t.slice(0, 500)).join("\n\n");

  if (summary.length < 100) return null;
  return summary.slice(0, 2000);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const input = await readStdin();
const sessionId = input.session_id ?? "unknown";
const transcriptPath = input.transcript_path;

const store = createLightStore(sessionId);

try {
  let correctionsFound = 0;
  let discoveryStored = false;

  // Parse transcript — messages may be at top level or nested under .message
  let messages: TranscriptMessage[] = [];
  if (transcriptPath && existsSync(transcriptPath)) {
    const lines = readFileSync(transcriptPath, "utf-8").trim().split("\n");
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        const msg = parsed.message ?? parsed;
        if (msg.role) {
          messages.push(msg);
        }
      } catch {
        // Skip malformed lines
      }
    }
  }

  // --- Self-correction detection ---
  if (messages.length > 0) {
    const sequence = extractToolSequences(messages);
    const corrections = detectCorrections(sequence);

    for (const c of corrections) {
      const content = `Auto-detected correction with ${c.failedTool}:\n\nFailed approach: ${c.failedInput}\nWorking approach: ${c.succeededInput}`;
      await store.insertRawMemory(content, "correction", 1.5);
      correctionsFound++;
    }

    // --- Discovery detection ---
    // Independent of corrections: discoveries capture architectural understanding,
    // corrections capture what went wrong. Both are valuable.
    const totalTokens = sumTokens(messages);

    if (totalTokens >= DISCOVERY_TOKEN_THRESHOLD) {
      const exploration = countExplorationTools(sequence);
      const explorationRatio = (exploration.reads + exploration.searches) /
        Math.max(exploration.reads + exploration.searches + exploration.edits, 1);

      // High exploration ratio = mostly reading/searching, not editing
      // This indicates the agent was learning about the codebase
      if (explorationRatio > 0.5) {
        const texts = extractTextBlocks(messages);
        const summary = buildDiscoverySummary(texts);

        if (summary) {
          await store.insertRawMemory(
            `[Discovery after ${Math.round(totalTokens / 1000)}k tokens, ${sequence.length} tool calls]\n\n${summary}`,
            "discovery",
            1.0,
          );
          discoveryStored = true;
        }
      }
    }
  }

  // --- Failure pattern detection ---
  const failuresFile = join(getSessionsDir(), `${sessionId}.failures.jsonl`);
  if (existsSync(failuresFile)) {
    const failureLines = readFileSync(failuresFile, "utf-8").trim().split("\n");
    const failures: FailureEntry[] = failureLines
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);

    const toolFailCounts = new Map<string, number>();
    for (const f of failures) {
      toolFailCounts.set(f.tool_name, (toolFailCounts.get(f.tool_name) ?? 0) + 1);
    }

    for (const [tool, count] of toolFailCounts) {
      if (count >= 3) {
        const examples = failures
          .filter(f => f.tool_name === tool)
          .slice(0, 2)
          .map(f => f.error_summary.slice(0, 100))
          .join("; ");
        const content = `Repeated failures with ${tool} (${count}x in session): ${examples}`;
        await store.insertRawMemory(content, "correction", 1.0);
        correctionsFound++;
      }
    }
  }

  if (correctionsFound > 0) {
    console.error(`memelord: stored ${correctionsFound} auto-detected corrections`);
  }
  if (discoveryStored) {
    console.error(`memelord: stored 1 discovery from high-token exploration`);
  }
} catch (e: any) {
  console.error(`memelord Stop error: ${e.message}`);
} finally {
  await store.close();
}
