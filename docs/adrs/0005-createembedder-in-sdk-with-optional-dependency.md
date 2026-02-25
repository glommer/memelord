# ADR 0005: Export createEmbedder From the SDK With Optional @huggingface/transformers

- Status: Accepted
- Date: 2026-02-25

## Context

The OpenCode plugin needs to create embeddings during the embed/decay workflow.

Historically, `createEmbedder` lived in the CLI package. Depending on the CLI from a plugin is undesirable; the plugin should depend on the SDK package (`memelord`).

At the same time, `@huggingface/transformers` is a heavy dependency and may be unnecessary (or problematic) for SDK consumers that only need the SQLite-backed store APIs (e.g., an MCP server).

## Decision

- Move `createEmbedder` to the SDK (`packages/sdk/src/embedder.ts`) and export it from the SDK index.
- List `@huggingface/transformers` as an `optionalDependency` for the SDK.
- Implement `createEmbedder` using a dynamic `import("@huggingface/transformers")` guarded by a clear, actionable error message if the package is missing.
- Ensure the OpenCode plugin's `.opencode/package.json` includes `@huggingface/transformers` as a direct dependency (since the plugin always needs embedding support).

## Consequences

- Pros:
  - Plugin depends only on the SDK (clean dependency graph).
  - Non-embedding SDK consumers avoid unnecessary install size and potential platform issues.
  - Error messages guide users to install the optional dependency when needed.
- Cons:
  - Requires careful packaging so the optional dependency is resolvable at runtime.
  - Some environments may still fail to install transformers; plugin must surface failures clearly.

## Alternatives Considered

- Keep createEmbedder in the CLI.
  - Rejected: plugin would need to depend on CLI internals or duplicate code.
- Make transformers a hard SDK dependency.
  - Rejected: penalizes all SDK consumers, increases install size, and raises platform risk.
