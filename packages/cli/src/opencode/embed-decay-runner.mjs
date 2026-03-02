// @ts-check

import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * Detached embed/decay runner for the OpenCode plugin.
 *
 * This file is written into a project's `.opencode/plugins/` directory by
 * `memelord init` and executed by spawning the current JS runtime.
 *
 * It waits for a delay, checks a "latest-wins" schedule token, then runs:
 * `memelord.runEmbedDecayMaintenance({ sessionId, dataDir, embed, cleanupSessionFiles: true })`.
 *
 * All failures are swallowed; this process should never crash OpenCode.
 */

/** @param {string} name */
function env(name) {
	const v = process.env[name];
	return typeof v === "string" ? v : "";
}

/**
 * @param {string} raw
 * @param {number} fallback
 */
function parseDelayMs(raw, fallback) {
	const n = Number.parseInt(raw, 10);
	if (Number.isFinite(n) && n > 0) return n;
	return fallback;
}

async function main() {
	const scheduleId = env("MEMELORD_EMBED_SCHEDULE_ID");
	const tokenFile = env("MEMELORD_EMBED_TOKEN_FILE");
	const sessionId = env("MEMELORD_EMBED_SESSION_ID");
	const dataDir = env("MEMELORD_EMBED_DATA_DIR");
	const delayMs = parseDelayMs(env("MEMELORD_EMBED_DELAY_MS"), 90_000);

	await sleep(delayMs);

	if (tokenFile.length > 0 && scheduleId.length > 0) {
		try {
			const latest = readFileSync(tokenFile, "utf8").trim();
			if (latest && latest !== scheduleId) return;
		} catch {
			// Best-effort: if the token can't be read, proceed.
		}
	}

	if (sessionId.length === 0 || dataDir.length === 0) return;

	try {
		const memelord = /** @type {any} */ (await import("memelord"));
		const embedder = /** @type {any} */ (await import("memelord-embedder"));

		const run = memelord?.runEmbedDecayMaintenance;
		const createEmbedder = embedder?.createEmbedder;

		if (typeof run !== "function" || typeof createEmbedder !== "function") return;

		const embed = await createEmbedder();
		await run({ sessionId, dataDir, embed, cleanupSessionFiles: true });
	} catch {
		// Swallow errors; this is a detached best-effort runner.
	}
}

main()
	.catch(() => {})
	.finally(() => {
		try {
			process.exit(0);
		} catch {
			// noop
		}
	});
