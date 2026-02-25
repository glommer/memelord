# ADR 0006: Robust Tool Failure Detection Across OpenCode Failure Shapes

- Status: Accepted
- Date: 2026-02-25

## Context

memelord records tool failures for later analysis (corrections and failure pattern memories).

In OpenCode, tool failure representation is not uniform across tools:

- Some tools report errors via a tool state status of `"error"` with a dedicated `error` field (and no `output`).
- The `bash` tool can return `status: "completed"` even on failures, and indicates failure via `metadata.exit` (non-zero) while also emitting stderr/stdout in `output`.

Additionally, the plugin hook API normalizes outputs for `tool.execute.after` into `{ output: string, metadata: any }`, so failure detection needs to be resilient to representation changes.

## Decision

Implement a single failure detector used by both:

- `tool.execute.after` (for appending failures to JSONL)
- transcript analysis over stored message parts (for correction detection)

Failure conditions include:

- `metadata.exit !== 0` (primary)
- `metadata.exitCode !== 0` (fallback for API changes)
- known error string prefixes/patterns on `output` (checked only on the first N characters to reduce false positives)
- `metadata.success === false` or `metadata.isError === true` (if present)

## Consequences

- Pros:
  - Captures both error-status and non-zero-exit failure modes.
  - More resilient to OpenCode API changes (dual exit fields).
  - Reduces noise by limiting string scanning to a small prefix.
- Cons:
  - Still heuristic for some tools; could miss failures that do not match patterns.
  - Potential false positives if a successful tool output begins with error-like text (mitigated by prefix limit).

## Alternatives Considered

- Tool-specific failure detectors.
  - Rejected: higher maintenance surface and less resilient to new tools.
- Rely only on OpenCode `status === "error"`.
  - Rejected: misses bash failures where status remains "completed".
