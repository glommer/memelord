import { readFileSync } from "fs";

/**
 * Generate the OpenCode plugin source.
 *
 * Used by `memelord init` to write `{targetDir}/.opencode/plugins/memelord.ts`.
 * The generated plugin has `DATA_DIR` baked in and expects `memelord` to be
 * installed in `{targetDir}/.opencode`.
 */
export function generatePluginSource(config: { dataDir: string }): string {
  const templateUrl = new URL("./opencode-plugin-template.ts", import.meta.url);
  const template = readFileSync(templateUrl, "utf-8");

  const quoted = JSON.stringify(config.dataDir);
  return template
    .replaceAll("\"__DATA_DIR__\"", quoted)
    .replaceAll("'__DATA_DIR__'", quoted);
}
