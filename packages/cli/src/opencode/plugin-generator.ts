import { readFileSync } from "fs";

/**
 * Generate the OpenCode plugin source.
 *
 * Used by `memelord init` to write `{targetDir}/.opencode/plugins/memelord.ts`.
 * The generated plugin has `DATA_DIR` baked in and expects `memelord` to be
 * installed in `{targetDir}/.opencode`.
 */
export function generatePluginSource(config: { dataDir: string }): string {
  const templateUrl = new URL("./plugin-template.ts", import.meta.url);
  const template = readFileSync(templateUrl, "utf-8");

  const quoted = JSON.stringify(config.dataDir);
  return template
    .replaceAll("\"__DATA_DIR__\"", quoted)
    .replaceAll("'__DATA_DIR__'", quoted);
}

/**
 * Read the detached embed/decay runner source for the OpenCode plugin.
 *
 * `memelord init` writes this file into `{targetDir}/.opencode/plugins/` and
 * the generated plugin spawns it instead of using `node -e`.
 */
export function getEmbedDecayRunnerSource(): string {
  const runnerUrl = new URL("./embed-decay-runner.mjs", import.meta.url);
  return readFileSync(runnerUrl, "utf-8");
}
