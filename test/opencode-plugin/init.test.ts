import { describe, expect, test } from "bun:test";
import ts from "typescript";

import {
	copyFileSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	unlinkSync,
} from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

function decode(out: Uint8Array | ArrayBuffer | string): string {
	if (typeof out === "string") return out;
	// Bun.spawnSync returns Uint8Array for stdout/stderr.
	const u8 = out instanceof Uint8Array ? out : new Uint8Array(out);
	return new TextDecoder().decode(u8);
}

describe("memelord init (OpenCode plugin outputs)", () => {
		test("writes OpenCode plugin + config files", () => {
			const dir = mkdtempSync(join(tmpdir(), "memelord-init-"));
			const templateDest = resolve(process.cwd(), "dist", "plugin-template.ts");
			let createdDistTemplate = false;
			try {
				const cliPath = resolve(process.cwd(), "dist", "cli.mjs");
				if (!existsSync(cliPath)) {
					const build = Bun.spawnSync({
						cmd: [process.execPath, "run", "build"],
						stdout: "pipe",
						stderr: "pipe",
					});
					expect(build.exitCode).toBe(0);
				}
				expect(existsSync(cliPath)).toBe(true);

				// `dist/cli.mjs` expects the OpenCode plugin template to exist next to it.
				// `bun run build` copies it, but tests should be runnable without a build.
				if (!existsSync(templateDest)) {
					copyFileSync(
						resolve(
							process.cwd(),
							"packages",
							"cli",
							"src",
							"opencode",
							"plugin-template.ts",
						),
						templateDest,
					);
					createdDistTemplate = true;
				}

			const result = Bun.spawnSync({
				cmd: ["node", cliPath, "init", dir],
				stdout: "pipe",
				stderr: "pipe",
			});

			expect(result.exitCode).toBe(0);

			const stdout = decode(result.stdout);
			expect(stdout).toContain("Wrote opencode.json (OpenCode)");
			expect(stdout).toContain(
				"Wrote .opencode/plugins/memelord.ts (OpenCode plugin)",
			);
			expect(stdout).toContain(
				"Wrote .opencode/package.json (OpenCode plugin dependencies)",
			);

			// Phase 6.5 checklist items
			expect(existsSync(join(dir, ".memelord"))).toBe(true);

			const mcpJson = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf-8"));
			expect(mcpJson.mcpServers?.memelord).toBeTruthy();
			expect(mcpJson.mcpServers.memelord.env?.MEMELORD_DIR).toBe(
				join(dir, ".memelord"),
			);

			const opencodeJson = JSON.parse(
				readFileSync(join(dir, "opencode.json"), "utf-8"),
			);
			expect(opencodeJson.mcp?.memelord).toBeTruthy();
			expect(opencodeJson.mcp.memelord.environment?.MEMELORD_DIR).toBe(
				join(dir, ".memelord"),
			);

			const pluginPath = join(dir, ".opencode", "plugins", "memelord.ts");
			expect(existsSync(pluginPath)).toBe(true);
			const pluginSource = readFileSync(pluginPath, "utf-8");
			expect(pluginSource.includes("__DATA_DIR__")).toBe(false);
			expect(pluginSource).toContain(
				`const DATA_DIR = ${JSON.stringify(join(dir, ".memelord"))}`,
			);

			const transpiled = ts.transpileModule(pluginSource, {
				compilerOptions: {
					target: ts.ScriptTarget.ES2022,
					module: ts.ModuleKind.ES2022,
				},
				reportDiagnostics: true,
			});
			expect(transpiled.diagnostics?.length ?? 0).toBe(0);

			const ocPkg = JSON.parse(
				readFileSync(join(dir, ".opencode", "package.json"), "utf-8"),
			);
			expect(ocPkg.dependencies?.memelord).toMatch(/^\^/);
			expect(typeof ocPkg.dependencies?.["memelord-embedder"]).toBe("string");
			expect(typeof ocPkg.dependencies?.["@opencode-ai/plugin"]).toBe("string");
			} finally {
				rmSync(dir, { recursive: true, force: true });
				if (createdDistTemplate && existsSync(templateDest)) {
					unlinkSync(templateDest);
				}
			}
		});
});
