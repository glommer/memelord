# ADR 0002: Generate OpenCode Plugin From a Real TypeScript Template File

- Status: Accepted
- Date: 2026-02-25

## Context

OpenCode expects plugins as files under `.opencode/plugins/`.

The plugin needs runtime configuration (the project-specific `.memelord` data directory path). We also want good developer ergonomics while authoring the plugin source.

Common approaches:

- A template string embedded inside the CLI generator.
- A real `.ts` file edited like normal source, with a small substitution step at generation time.

Template strings typically lose IDE support (type checking, autocomplete, refactoring), making it easy to ship broken plugin code.

## Decision

Author the OpenCode plugin as a real TypeScript source file (checked by the TypeScript language service) and generate the installed plugin by replacing a placeholder constant.

- Source of truth: `packages/cli/src/opencode-plugin-template.ts`.
- Placeholder: `const DATA_DIR = "__DATA_DIR__"`.
- Generation: `generatePluginSource({ dataDir })` reads the template source, replaces the quoted placeholder with the project-specific absolute path, and writes the result to `.opencode/plugins/memelord.ts`.

## Consequences

- Pros:
  - Full IDE/type-checking support during development.
  - Simple, transparent generation (string replacement; no AST tooling required).
  - Installed plugin is a single file (easy for OpenCode to load).
- Cons:
  - Requires a build-time/read-time access to the template source when generating.
  - Must ensure `generatePluginSource()` works across build targets (dev vs bundled distributions).

## Alternatives Considered

- Template literal string generator (inline code).
  - Rejected: poor developer experience and higher risk of runtime errors.
- Separate runtime config file rather than placeholder substitution.
  - Rejected: adds another file to manage and increases the chance of misconfiguration.
- AST-based code generation.
  - Rejected: unnecessary complexity for a single placeholder replacement.
