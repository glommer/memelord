# ADR 0008: Tool Failure Detection via ToolState (No Heuristic Fallback)

- Status: Accepted
- Date: 2026-02-25

## Context

memelord records tool failures for later analysis (corrections and failure-pattern memories).

The OpenCode plugin hook `tool.execute.after` provides a normalized payload:

- input: `{ tool, sessionID, callID, args }`
- output: `{ title, output: string, metadata: any }`

This output shape does not carry a typed tool `status` (e.g. `"error"` vs `"completed"`), and `metadata` is not strongly typed. A purely heuristic detector (string scanning / ad-hoc metadata checks) is brittle and can produce false positives/negatives.

OpenCode's stored message parts, however, contain a fully-typed discriminated union for tool execution:

- `ToolPart.state.status` is one of `"pending" | "running" | "completed" | "error"`.
- `status: "error"` has a dedicated `error` field.
- `status: "completed"` includes `output` and `metadata` (bash failures are signaled via non-zero `metadata.exit`, with `exitCode` as a potential fallback).

## Decision

Detect and record tool failures by looking up the canonical `ToolPart` by `callID` and branching on `ToolState.status`.

In `tool.execute.after`:

1. Fetch recent session messages via `client.session.messages({ path: { id: sessionID } })`.
2. Find the `ToolPart` where `part.type === "tool" && part.callID === callID`.
3. Determine failure using `ToolState`:
   - `status === "error"` => failure; summary is `state.error`.
   - `status === "completed"` => failure if `metadata.exit !== 0` (or `metadata.exitCode !== 0`); summary is `state.output` (or an exit-code message if empty).
4. Append a CC-compatible JSONL line to `.memelord/sessions/<sessionID>.failures.jsonl`.

Do not keep a heuristic fallback based on the normalized hook `output.output` string.

## Consequences

- Pros:
  - Uses a discriminated union (`ToolState`) rather than heuristics.
  - Avoids false positives caused by error-like text appearing in successful tool output.
  - Aligns failure detection with the same source of truth used by transcript analysis.
- Cons:
  - Requires an additional read of recent session messages in `tool.execute.after`.
  - If the tool part cannot be found (retention/race conditions), the failure will not be recorded.

## Alternatives Considered

- Heuristic detector on `tool.execute.after` output strings.
  - Rejected: brittle and hard to reason about as OpenCode tools evolve.
