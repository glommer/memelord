# ADR 0005: Extract createEmbedder Into a Dedicated memelord-embedder Package

- Status: Superseded by this revision (originally accepted 2026-02-25, revised 2026-02-25)

## Context

The OpenCode plugin needs to create embeddings during the embed/decay workflow.

`createEmbedder` originally lived in `packages/cli/src/embedder.ts`. The first revision of this ADR proposed moving it into the SDK (`memelord`) as an `optionalDependency` so the plugin could depend on the SDK without pulling in the CLI.

However, using `optionalDependencies` adds complexity: the implementation needs a dynamic `import()` guard with a runtime error message, the plugin's generated `.opencode/package.json` must re-list `@huggingface/transformers` as a direct dep, and SDK consumers that never embed still see the optional dep listed. The simpler cut is a dedicated workspace package.

## Decision

- Create `packages/embedder` (package name: `memelord-embedder`) with `@huggingface/transformers` as its sole hard `dependency` and `createEmbedder` as its sole export.
- Remove `createEmbedder` from the SDK (`memelord`) entirely. The SDK has no knowledge of or dependency on `@huggingface/transformers`.
- `packages/cli/src/embedder.ts` re-exports from `memelord-embedder` (unchanged public API for CLI internals).
- The OpenCode plugin template (`packages/cli/src/opencode/plugin-template.ts`) imports `createEmbedder` from `memelord-embedder` directly.
- The plugin's generated `.opencode/package.json` lists `memelord-embedder` as a dependency (not `memelord` + transformers separately).

## Consequences

- Pros:
  - Clean dependency graph: SDK has no embedding dep, CLI and plugin each pull in only `memelord-embedder`.
  - No optional/dynamic-import complexity — `createEmbedder` is a plain static import.
  - `memelord-embedder` can be published independently if useful.
- Cons:
  - One additional workspace package to maintain.
  - The published root `package.json` (which ships `dist/cli.mjs`) still lists `@huggingface/transformers` as a hard dep since the bundled CLI binary needs it at runtime.

## Alternatives Considered

- Keep `createEmbedder` in the CLI.
  - Rejected: the OpenCode plugin would need to depend on CLI internals or duplicate code.
- SDK optional dependency (original ADR 0005 decision).
  - Rejected: complexity of dynamic import guard, redundant dep declaration in generated plugin package.json, and misleading presence in the SDK for non-embedding consumers.
