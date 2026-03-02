import { describe, expect, test } from "bun:test";

import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { randomUUID } from "crypto";
import { pathToFileURL } from "url";

import { generatePluginSource } from "../../packages/cli/src/opencode/plugin-generator";

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

function writeRunnerFile(runnerPath: string): void {
	const src = `// test-only runner (fast)
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const scheduleId = process.env.MEMELORD_EMBED_SCHEDULE_ID || "";
const tokenFile = process.env.MEMELORD_EMBED_TOKEN_FILE || "";
const sessionId = process.env.MEMELORD_EMBED_SESSION_ID || "";
const dataDir = process.env.MEMELORD_EMBED_DATA_DIR || "";

// Give the plugin time to write the token file.
await sleep(150);

let latest = "";
try {
  latest = readFileSync(tokenFile, "utf8").trim();
} catch {
  // noop
}

if (!latest || latest !== scheduleId) {
  process.exit(0);
}

const marker = join(dataDir, "sessions", 
  sessionId.length > 0 ? 
    (sessionId + ".runner-ran") : 
    ("unknown.runner-ran")
);
mkdirSync(dirname(marker), { recursive: true });
writeFileSync(marker, "ran", "utf8");
process.exit(0);
`;

	mkdirSync(dirname(runnerPath), { recursive: true });
	writeFileSync(runnerPath, src, "utf-8");
}

function writePluginFile(pluginPath: string, dataDir: string): void {
	const source = generatePluginSource({ dataDir });
	mkdirSync(dirname(pluginPath), { recursive: true });
	writeFileSync(pluginPath, source, "utf-8");
}

async function loadPlugin(pluginPath: string): Promise<any> {
	// Bypass module cache by varying query.
	const url = pathToFileURL(pluginPath).href + `?t=${Date.now()}`;
	return await import(url);
}

function makeProjectDir(): string {
	const base = join(process.cwd(), "test", ".tmp");
	mkdirSync(base, { recursive: true });
	const dir = join(base, `oc-plugin-${randomUUID()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

describe("OpenCode plugin embed/decay cancellation", () => {
	test("session.prompt cancels pending embed/decay schedule token", async () => {
		const projectDir = makeProjectDir();
		try {
			const dataDir = join(projectDir, ".memelord");
			const sessionId = "s_" + randomUUID();
			const tokenFile = join(dataDir, "sessions", `${sessionId}.embed-decay.latest`);

			const pluginPath = join(projectDir, ".opencode", "plugins", "memelord.ts");
			writePluginFile(pluginPath, dataDir);

			const mod = await loadPlugin(pluginPath);
			const hooks = await mod.MemelordPlugin({ client: {}, directory: "", worktree: "" } as any);

			mkdirSync(dirname(tokenFile), { recursive: true });
			writeFileSync(tokenFile, "scheduled", "utf-8");

			await hooks["session.prompt"]({
				path: { id: sessionId },
				body: { parts: [{ type: "text", text: "hi" }], noReply: false },
			}, {});

			const after = readFileSync(tokenFile, "utf-8").trim();
			expect(after).not.toBe("scheduled");
			expect(after.length).toBeGreaterThan(0);
		} finally {
			rmSync(projectDir, { recursive: true, force: true });
		}
	});

	test("session.prompt with noReply does not cancel (context injection)", async () => {
		const projectDir = makeProjectDir();
		try {
			const dataDir = join(projectDir, ".memelord");
			const sessionId = "s_" + randomUUID();
			const tokenFile = join(dataDir, "sessions", `${sessionId}.embed-decay.latest`);

			const pluginPath = join(projectDir, ".opencode", "plugins", "memelord.ts");
			writePluginFile(pluginPath, dataDir);

			const mod = await loadPlugin(pluginPath);
			const hooks = await mod.MemelordPlugin({ client: {}, directory: "", worktree: "" } as any);

			mkdirSync(dirname(tokenFile), { recursive: true });
			writeFileSync(tokenFile, "scheduled", "utf-8");

			await hooks["session.prompt"]({
				path: { id: sessionId },
				body: { parts: [{ type: "text", text: "context" }], noReply: true },
			}, {});

			const after = readFileSync(tokenFile, "utf-8").trim();
			expect(after).toBe("scheduled");
		} finally {
			rmSync(projectDir, { recursive: true, force: true });
		}
	});

	test("session.command cancels pending embed/decay schedule token", async () => {
		const projectDir = makeProjectDir();
		try {
			const dataDir = join(projectDir, ".memelord");
			const sessionId = "s_" + randomUUID();
			const tokenFile = join(dataDir, "sessions", `${sessionId}.embed-decay.latest`);

			const pluginPath = join(projectDir, ".opencode", "plugins", "memelord.ts");
			writePluginFile(pluginPath, dataDir);

			const mod = await loadPlugin(pluginPath);
			const hooks = await mod.MemelordPlugin({ client: {}, directory: "", worktree: "" } as any);

			mkdirSync(dirname(tokenFile), { recursive: true });
			writeFileSync(tokenFile, "scheduled", "utf-8");

			await hooks["session.command"]({ path: { id: sessionId } }, {});

			const after = readFileSync(tokenFile, "utf-8").trim();
			expect(after).not.toBe("scheduled");
			expect(after.length).toBeGreaterThan(0);
		} finally {
			rmSync(projectDir, { recursive: true, force: true });
		}
	});

	test("prompt cancels detached runner before it executes", async () => {
		const projectDir = makeProjectDir();
		try {
			const dataDir = join(projectDir, ".memelord");
			const sessionId = "s_" + randomUUID();
			const runnerPath = join(
				projectDir,
				".opencode",
				"plugins",
				"memelord.embed-decay-runner.mjs",
			);
			writeRunnerFile(runnerPath);

			// Ensure db path exists so session.idle doesn't early return.
			mkdirSync(dataDir, { recursive: true });
			writeFileSync(join(dataDir, "memory.db"), "", "utf-8");

			const pluginPath = join(projectDir, ".opencode", "plugins", "memelord.ts");
			writePluginFile(pluginPath, dataDir);

			const messages = [
				{
					info: {
						role: "assistant",
						tokens: { input: 1, output: 1, cache: { write: 0 } },
					},
					parts: [],
				},
			];
			const client = {
				session: {
					messages: async () => ({ data: messages }),
				},
			};

			const mod = await loadPlugin(pluginPath);
			const hooks = await mod.MemelordPlugin({ client, directory: "", worktree: "" } as any);

			await hooks.event({
				event: { type: "session.idle", properties: { sessionID: sessionId } },
			});

			// Cancel quickly, before the runner checks the token.
			await hooks["session.prompt"]({
				path: { id: sessionId },
				body: { parts: [{ type: "text", text: "back" }], noReply: false },
			}, {});

			const marker = join(dataDir, "sessions", `${sessionId}.runner-ran`);
			await sleep(450);
			expect(existsSync(marker)).toBe(false);
		} finally {
			// Give detached process time to exit before cleanup.
			await sleep(100);
			rmSync(projectDir, { recursive: true, force: true });
		}
	});

	test("detached runner executes when not cancelled", async () => {
		const projectDir = makeProjectDir();
		try {
			const dataDir = join(projectDir, ".memelord");
			const sessionId = "s_" + randomUUID();
			const runnerPath = join(
				projectDir,
				".opencode",
				"plugins",
				"memelord.embed-decay-runner.mjs",
			);
			writeRunnerFile(runnerPath);

			mkdirSync(dataDir, { recursive: true });
			writeFileSync(join(dataDir, "memory.db"), "", "utf-8");

			const pluginPath = join(projectDir, ".opencode", "plugins", "memelord.ts");
			writePluginFile(pluginPath, dataDir);

			const messages = [
				{
					info: {
						role: "assistant",
						tokens: { input: 1, output: 1, cache: { write: 0 } },
					},
					parts: [],
				},
			];
			const client = {
				session: {
					messages: async () => ({ data: messages }),
				},
			};

			const mod = await loadPlugin(pluginPath);
			const hooks = await mod.MemelordPlugin({ client, directory: "", worktree: "" } as any);

			await hooks.event({
				event: { type: "session.idle", properties: { sessionID: sessionId } },
			});

			const marker = join(dataDir, "sessions", `${sessionId}.runner-ran`);
			await sleep(450);
			expect(existsSync(marker)).toBe(true);
			expect(readFileSync(marker, "utf-8").trim()).toBe("ran");
		} finally {
			await sleep(100);
			rmSync(projectDir, { recursive: true, force: true });
		}
	});
});
