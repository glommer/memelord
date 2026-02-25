import { describe, expect, test } from "bun:test";
import ts from "typescript";
import { generatePluginSource } from "../packages/cli/src/opencode/plugin-generator";

describe("generatePluginSource", () => {
  test("replaces DATA_DIR placeholder and returns valid TypeScript", () => {
    const dataDir = "/tmp/test-memelord";
    const source = generatePluginSource({ dataDir });

    expect(source.includes("__DATA_DIR__")).toBe(false);
    expect(source.includes(`const DATA_DIR = ${JSON.stringify(dataDir)}`)).toBe(true);
    expect(source.includes("export const MemelordPlugin")).toBe(true);

    const transpiled = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ES2022,
      },
      reportDiagnostics: true,
    });
    expect(transpiled.diagnostics?.length ?? 0).toBe(0);
  });
});
