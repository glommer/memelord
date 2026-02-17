/**
 * PostToolUse hook: Record tool failures to session JSONL for later analysis.
 * Hot path — no DB access, just append to a file. Exits immediately on success.
 */
import { readStdin, getSessionsDir } from "./shared.ts";
import { appendFileSync } from "fs";
import { join } from "path";

const input = await readStdin();

// Fast exit for successful tool calls (vast majority of cases)
const response = input.tool_response;
if (!response) process.exit(0);

// Detect failures from structured tool_response fields
// Only check top-level fields, NOT serialized content (which contains file text, code, etc.)
const isFailure =
  (typeof response === "object" && response.success === false) ||
  (typeof response === "object" && response.isError === true) ||
  (typeof response === "string" && (
    response.startsWith("Error:") ||
    response.startsWith("error:") ||
    response.includes("ENOENT") ||
    response.includes("command not found") ||
    response.includes("No such file") ||
    response.includes("Permission denied")
  )) ||
  // Bash tool: check exit code in structured response
  (typeof response === "object" && typeof response.exitCode === "number" && response.exitCode !== 0);

if (!isFailure) process.exit(0);

// Record the failure
const sessionId = input.session_id ?? "unknown";
const errorSummary = typeof response === "string"
  ? response.slice(0, 500)
  : (response.error ?? response.message ?? JSON.stringify(response).slice(0, 500));
const entry = {
  timestamp: Math.floor(Date.now() / 1000),
  tool_name: input.tool_name,
  tool_input: input.tool_input,
  error_summary: errorSummary,
};

const failuresFile = join(getSessionsDir(), `${sessionId}.failures.jsonl`);
appendFileSync(failuresFile, JSON.stringify(entry) + "\n");
