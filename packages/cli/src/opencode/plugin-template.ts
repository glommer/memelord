import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import type { Message, Part, ToolPart, ToolState } from "@opencode-ai/sdk";
import { createMemoryStore, type MemoryStore, type Memory } from "memelord";
import { createEmbedder } from "memelord-embedder";
import { resolve, join } from "path";
import {
	existsSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
	appendFileSync,
	unlinkSync,
} from "fs";
import { spawn } from "child_process";

// Replaced by generatePluginSource() at init time
const DATA_DIR = "__DATA_DIR__";

const DISCOVERY_TOKEN_THRESHOLD = 50_000;
const PENALIZE_TOKEN_THRESHOLD = 20_000;
const EMBED_DECAY_DELAY_MS = 5 * 60 * 1000; // 5 minutes

function getDbPath(): string {
	return resolve(DATA_DIR, "memory.db");
}

function getSessionsDir(): string {
	const dir = join(DATA_DIR, "sessions");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	return dir;
}

const dummyEmbed = async () => new Float32Array(384);

function createLightStore(sessionId: string): MemoryStore {
	return createMemoryStore({
		dbPath: getDbPath(),
		sessionId,
		embed: dummyEmbed,
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object";
}

function getExitCodeFromMetadata(metadata: unknown): number | null {
	if (!isRecord(metadata)) return null;

	const exit = metadata.exit;
	if (typeof exit === "number") return exit;

	const exitCode = metadata.exitCode;
	if (typeof exitCode === "number") return exitCode;

	return null;
}

export function getOpenCodeToolFailureSummaryFromState(
	state: ToolState,
): string | null {
	switch (state.status) {
		case "error": {
			return state.error;
		}
		case "completed": {
			const exit = getExitCodeFromMetadata(state.metadata);
			if (typeof exit === "number" && exit !== 0) {
				const out = state.output?.trim() ?? "";
				return out.length > 0 ? out : `Tool failed with exit code ${exit}`;
			}

			// Some tools may report failures via metadata flags.
			if (isRecord(state.metadata)) {
				if (state.metadata.success === false) return state.output;
				if (state.metadata.isError === true) return state.output;
			}

			return null;
		}
		case "pending":
		case "running": {
			return null;
		}
		default: {
			const _exhaustive: never = state;
			return _exhaustive;
		}
	}
}

export function findToolPartByCallID(
	messages: Array<{ info: Message; parts: Part[] }>,
	callID: string,
): ToolPart | null {
	let found: ToolPart | null = null;

	for (const message of messages) {
		for (const part of message.parts) {
			if (part.type === "tool" && part.callID === callID) found = part;
		}
	}

	return found;
}

export function formatFailureEntryFromSummary(
	toolName: string,
	toolInput: any,
	errorSummary: string,
): {
	timestamp: number;
	tool_name: string;
	tool_input: any;
	error_summary: string;
} {
	return {
		timestamp: Math.floor(Date.now() / 1000),
		tool_name: toolName,
		tool_input: toolInput,
		error_summary: (errorSummary ?? "").slice(0, 500),
	};
}

export function buildSessionStartContext(
	memories: Array<Pick<Memory, "id" | "content" | "category" | "weight">>,
): string {
	let context = "";

	if (memories.length > 0) {
		context += "# Memories from past sessions\n\n";
		for (const mem of memories) {
			context += `[${mem.category}] (id: ${mem.id}, weight: ${mem.weight.toFixed(2)})\n${mem.content}\n\n`;
		}
	}

	// Keep this block identical to packages/cli/src/claude/hooks.ts
	context += `# Memory system instructions

You have a persistent memory system available via MCP tools. Use it:

1. At the START of every task, call memory_start_task with the user's request. This retrieves task-relevant memories using vector search (more precise than the weight-based ones above).

2. When you self-correct (tried something that failed, then found the right approach), call memory_report with type "correction".

3. When the user corrects you or shares project knowledge, call memory_report with type "user_input". The user should never have to tell you the same thing twice.

4. When you discover something useful about the codebase (key file locations, architecture patterns, build/test conventions), call memory_report with type "insight". This saves future sessions from re-exploring the same codebase.

5. IMPORTANT — Before finishing a task, review the memories above against what you actually found. If any memory contains incorrect information (wrong file paths, wrong function names, wrong explanations), you MUST call memory_contradict with its id to remove it. Provide the correct information so future sessions get it right. Bad memories poison every future session if not removed.

6. When you finish a task, call memory_end_task with outcome metrics and rate each retrieved memory (0=ignored, 1=glanced, 2=useful, 3=directly applied).`;

	return context;
}

export type ToolSequenceEntry = { tool: string; input: any; failed: boolean };

function isOutputErrorString(output: unknown): boolean {
	if (typeof output !== "string") return false;
	const out = output.slice(0, 200);
	return (
		out.startsWith("Error:") ||
		out.startsWith("error:") ||
		out.includes("ENOENT") ||
		out.includes("command not found") ||
		out.includes("No such file") ||
		out.includes("Permission denied")
	);
}

export function extractToolSequencesFromOC(
	messages: Array<{ info: Message; parts: Part[] }>,
): ToolSequenceEntry[] {
	const sequence: ToolSequenceEntry[] = [];

	for (const message of messages) {
		for (const part of message.parts) {
			if (part.type !== "tool") continue;

			const tool = part.tool;
			const state = part.state;

			if (state.status === "pending" || state.status === "running") continue;

			let failed = false;
			if (state.status === "error") {
				failed = true;
			} else {
				const exit = getExitCodeFromMetadata(state.metadata);
				if (typeof exit === "number" && exit !== 0) failed = true;
				if (!failed && isOutputErrorString(state.output)) failed = true;
				if (!failed && isRecord(state.metadata)) {
					if (state.metadata.success === false) failed = true;
					if (state.metadata.isError === true) failed = true;
				}
			}

			sequence.push({ tool, input: state.input, failed });
		}
	}

	return sequence;
}

export type Correction = {
	failedTool: string;
	failedInput: string;
	succeededTool: string;
	succeededInput: string;
};

export function sumTokensFromOC(
	messages: Array<{ info: Message; parts: Part[] }>,
): number {
	let total = 0;
	for (const message of messages) {
		if (message.info.role !== "assistant") continue;
		total += message.info.tokens.input;
		total += message.info.tokens.output;
		total += message.info.tokens.cache.write;
	}
	return total;
}

export function countExplorationToolsOC(sequence: Array<{ tool: string }>): {
	reads: number;
	searches: number;
	edits: number;
} {
	let reads = 0;
	let searches = 0;
	let edits = 0;

	for (const s of sequence) {
		if (s.tool === "read") reads++;
		else if (s.tool === "grep" || s.tool === "glob") searches++;
		else if (
			s.tool === "edit" ||
			s.tool === "write" ||
			s.tool === "patch" ||
			s.tool === "apply_patch"
		)
			edits++;
	}

	return { reads, searches, edits };
}

export function extractTextBlocksFromOC(
	messages: Array<{ info: Message; parts: Part[] }>,
): string[] {
	const texts: string[] = [];
	for (const message of messages) {
		if (message.info.role !== "assistant") continue;

		for (const part of message.parts) {
			if (part.type !== "text") continue;
			if (part.text.length <= 80) continue;
			texts.push(part.text);
		}
	}
	return texts;
}

export function detectCorrections(sequence: ToolSequenceEntry[]): Correction[] {
	const corrections: Correction[] = [];

	for (const [i, step] of sequence.entries()) {
		if (i >= sequence.length - 1) break;
		if (!step.failed) continue;

		const lookahead = sequence.slice(i + 1, i + 4);
		for (const candidate of lookahead) {
			if (candidate.tool !== step.tool) continue;
			if (candidate.failed) continue;

			const failedInput =
				typeof step.input === "string"
					? step.input
					: JSON.stringify(step.input).slice(0, 200);
			const succeededInput =
				typeof candidate.input === "string"
					? candidate.input
					: JSON.stringify(candidate.input).slice(0, 200);

			if (failedInput !== succeededInput) {
				corrections.push({
					failedTool: step.tool,
					failedInput,
					succeededTool: candidate.tool,
					succeededInput,
				});
			}

			break;
		}
	}

	return corrections;
}

export function buildDiscoverySummary(texts: string[]): string | null {
	if (texts.length === 0) return null;

	const sorted = [...texts].sort((a, b) => b.length - a.length);
	const combined = new Set([...sorted.slice(0, 5), ...texts.slice(-2)]);
	const ordered = texts.filter((t) => combined.has(t));
	const summary = ordered.map((t) => t.slice(0, 500)).join("\n\n");

	if (summary.length < 100) return null;
	return summary.slice(0, 2000);
}

type FailureJsonlEntry = {
	tool_name?: unknown;
	error_summary?: unknown;
};

export function analyzeFailurePatterns(
	failuresJsonl: string,
): Array<{ content: string; category: "correction"; weight: number }> {
	const lines = failuresJsonl
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	if (lines.length === 0) return [];

	const failures: Array<{ tool_name: string; error_summary: string }> = [];
	for (const line of lines) {
		try {
			const parsed = JSON.parse(line) as FailureJsonlEntry;
			if (!isRecord(parsed)) continue;

			const tool = parsed.tool_name;
			const summary = parsed.error_summary;
			if (typeof tool !== "string" || tool.length === 0) continue;
			if (typeof summary !== "string") continue;

			failures.push({ tool_name: tool, error_summary: summary });
		} catch {
			// Ignore malformed lines.
		}
	}

	if (failures.length === 0) return [];

	const counts = new Map<string, number>();
	for (const f of failures)
		counts.set(f.tool_name, (counts.get(f.tool_name) ?? 0) + 1);

	const result: Array<{
		content: string;
		category: "correction";
		weight: number;
	}> = [];
	for (const [tool, count] of counts) {
		if (count < 3) continue;

		const examples = failures
			.filter((f) => f.tool_name === tool)
			.slice(0, 2)
			.map((f) => f.error_summary.slice(0, 100))
			.join("; ");

		result.push({
			content: `Repeated failures with ${tool} (${count}x in session): ${examples}`,
			category: "correction",
			weight: 1.0,
		});
	}

	return result;
}

const sessionMeta: Record<
	string,
	{ injectedMemoryIds: string[]; startedAt: number }
> = {};
let lastEmbedDecayPid: number | null = null;

export const MemelordPlugin: Plugin = async ({
	client,
	directory,
	worktree,
}: PluginInput) => {
	return {
		event: async ({ event }: any) => {
			void directory;
			void worktree;

			if (!event || typeof event.type !== "string") return;

			switch (event.type) {
				case "session.created": {
					try {
						const sessionID = (event.properties as any)?.info?.id;
						if (typeof sessionID !== "string" || sessionID.length === 0) return;

						if (!existsSync(getDbPath())) return;

						const store = createLightStore(sessionID);
						try {
							const memories = await store.getTopByWeight(5);

							const startedAt = Math.floor(Date.now() / 1000);
							const injectedIds = memories.map((m) => m.id);

							const sessionFile = join(getSessionsDir(), `${sessionID}.json`);
							writeFileSync(
								sessionFile,
								JSON.stringify({
									session_id: sessionID,
									started_at: startedAt,
									injected_memory_ids: injectedIds,
								}),
							);

							sessionMeta[sessionID] = {
								injectedMemoryIds: injectedIds,
								startedAt,
							};

							const context = buildSessionStartContext(memories);
							await client.session.prompt({
								path: { id: sessionID },
								body: {
									parts: [{ type: "text", text: context }],
									noReply: true,
								},
							});
						} finally {
							await store.close();
						}
					} catch (e: any) {
						console.error(`memelord SessionStart error: ${e.message}`);
					}
					return;
				}
				case "session.idle": {
					const sessionID = (event.properties as any)?.sessionID;
					if (typeof sessionID !== "string" || sessionID.length === 0) return;
					if (!existsSync(getDbPath())) return;

					try {
						const resp = await client.session.messages({
							path: { id: sessionID },
							query: { limit: 500 },
						});
						const messages = resp.data ?? [];
						if (messages.length === 0) return;

						const store = createLightStore(sessionID);
						try {
							const sequence = extractToolSequencesFromOC(messages);

							// --- Section A: Self-correction detection ---
							const corrections = detectCorrections(sequence);
							let correctionsFound = 0;
							for (const c of corrections) {
								const content = `Auto-detected correction with ${c.failedTool}:\n\nFailed approach: ${c.failedInput}\nWorking approach: ${c.succeededInput}`;
								await store.insertRawMemory(content, "correction", 1.5);
								correctionsFound++;
							}

							// --- Section B: Discovery detection ---
							const totalTokens = sumTokensFromOC(messages);
							let discoveryStored = false;
							if (totalTokens >= DISCOVERY_TOKEN_THRESHOLD) {
								const exploration = countExplorationToolsOC(sequence);
								const explorationRatio =
									(exploration.reads + exploration.searches) /
									Math.max(
										exploration.reads +
											exploration.searches +
											exploration.edits,
										1,
									);

								if (explorationRatio > 0.5) {
									const texts = extractTextBlocksFromOC(messages);
									const summary = buildDiscoverySummary(texts);
									if (summary) {
										const content = `[Discovery after ${Math.round(totalTokens / 1000)}k tokens, ${sequence.length} tool calls]\n\n${summary}`;
										await store.insertRawMemory(content, "discovery", 1.0);
										discoveryStored = true;
									}
								}
							}

							// --- Section C: Penalize injected memories ---
							if (totalTokens >= PENALIZE_TOKEN_THRESHOLD) {
								let injectedIds: string[] =
									sessionMeta[sessionID]?.injectedMemoryIds ?? [];
								if (injectedIds.length === 0) {
									const sessionFile = join(
										getSessionsDir(),
										`${sessionID}.json`,
									);
									if (existsSync(sessionFile)) {
										try {
											const session = JSON.parse(
												readFileSync(sessionFile, "utf-8"),
											);
											if (Array.isArray(session.injected_memory_ids)) {
												injectedIds = session.injected_memory_ids.filter(
													(id: any) => typeof id === "string",
												);
											}
										} catch {
											// Ignore parse errors.
										}
									}
								}

								if (injectedIds.length > 0) {
									for (const id of injectedIds) {
										await store.penalizeMemory(id, 0.999);
									}
									console.error(
										`memelord: penalized ${injectedIds.length} injected memories (session used ${Math.round(totalTokens / 1000)}k tokens)`,
									);
								}
							}

							// --- Section D: Failure pattern analysis ---
							const failuresFile = join(
								getSessionsDir(),
								`${sessionID}.failures.jsonl`,
							);
							if (existsSync(failuresFile)) {
								const failuresJsonl = readFileSync(failuresFile, "utf-8");
								const failureMemories = analyzeFailurePatterns(failuresJsonl);
								for (const fm of failureMemories) {
									await store.insertRawMemory(
										fm.content,
										fm.category,
										fm.weight,
									);
									correctionsFound++;
								}
							}

							// --- Section E: Log results ---
							if (correctionsFound > 0) {
								console.error(
									`memelord: stored ${correctionsFound} auto-detected corrections`,
								);
							}
							if (discoveryStored) {
								console.error(
									"memelord: stored 1 discovery from high-token exploration",
								);
							}
						} finally {
							await store.close();
						}

						// --- Section F: Spawn detached embed-decay process ---
						if (lastEmbedDecayPid !== null) {
							try {
								process.kill(lastEmbedDecayPid);
							} catch {
								// Process already exited.
							}
							lastEmbedDecayPid = null;
						}

						const projectRoot = resolve(DATA_DIR, "..");
						const localBin = join(
							projectRoot,
							".opencode",
							"node_modules",
							".bin",
							"memelord",
						);
						const candidates = [
							typeof process.env.MEMELORD_BIN === "string" &&
							process.env.MEMELORD_BIN.length > 0
								? process.env.MEMELORD_BIN
								: null,
							existsSync(localBin) ? localBin : null,
							"memelord",
						].filter((c): c is string => typeof c === "string" && c.length > 0);

						const args = ["hook", "embed-decay", sessionID, DATA_DIR];
						let spawned: number | null = null;
						for (const cmd of candidates) {
							try {
								const child = spawn(cmd, args, {
									detached: true,
									stdio: "ignore",
									env: { ...process.env },
								});
								child.on("error", () => {
									// Swallow spawn errors to avoid crashing the plugin.
								});
								child.unref();
								if (child.pid) {
									spawned = child.pid;
									break;
								}
							} catch {
								// Try next candidate.
							}
						}

						lastEmbedDecayPid = spawned;
						if (spawned === null) {
							console.error(
								"memelord: failed to spawn embed-decay process (memelord not found)",
							);
						}
					} catch (e: any) {
						console.error(`memelord session.idle error: ${e.message}`);
					}

					return;
				}
				default: {
					return;
				}
			}
		},
		"tool.execute.after": async (input: any, output: any) => {
			try {
				const toolName = input?.tool ?? "unknown";
				const sessionID = input?.sessionID ?? "unknown";
				const callID = input?.callID;

				void output;

				if (typeof callID !== "string" || callID.length === 0) return;

				const resp = await client.session.messages({
					path: { id: sessionID },
					query: { limit: 200 },
				});
				const messages = resp.data ?? [];

				const toolPart = findToolPartByCallID(messages, callID);
				if (!toolPart) return;

				const summary = getOpenCodeToolFailureSummaryFromState(toolPart.state);
				if (!summary) return;

				const entry = formatFailureEntryFromSummary(
					toolName,
					toolPart.state.input,
					summary,
				);
				const failuresFile = join(
					getSessionsDir(),
					`${sessionID}.failures.jsonl`,
				);
				appendFileSync(failuresFile, JSON.stringify(entry) + "\n");
			} catch (e: any) {
				console.error(`memelord PostToolUse error: ${e.message}`);
			}
		},
	};
};
