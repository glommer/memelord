# ADR 0003: Map Claude Code Hook Semantics to OpenCode Events and Tool Hooks

- Status: Accepted
- Date: 2026-02-25

## Context

The existing CC integration uses these lifecycle hook concepts:

- SessionStart: inject memories and memory-system instructions.
- PostToolUse: record tool failures.
- Stop: analyze each completed assistant turn.
- SessionEnd: embed pending memories, run decay, and cleanup.

OpenCode exposes different primitives:

- `session.created` event
- `session.idle` event (fires after each turn)
- `tool.execute.after` hook

Additionally, OpenCode does not provide a clear "session ended" event equivalent to CC's SessionEnd.

## Decision

Implement the CC behaviors in OpenCode using the closest event/hook mapping:

- SessionStart -> `session.created` (inject context via `client.session.prompt({ noReply: true })`).
- PostToolUse -> `tool.execute.after` (record tool failures to session JSONL).
- Stop -> `session.idle` (inline transcript analysis on every idle event).
- SessionEnd -> deferred background workflow (see ADR 0004).

## Consequences

- Pros:
  - Uses OpenCode-native primitives without forcing CC's process model.
  - Keeps the plugin self-contained and debuggable.
- Cons:
  - No true session termination signal; embed/decay must be triggered indirectly.
  - `session.idle` can fire multiple times per session, increasing the risk of duplicate analysis without additional guards (see ADR 0007).

## Alternatives Considered

- Wait for an OpenCode session termination event.
  - Rejected: currently unavailable/unreliable.
- Perform all work inline in `session.idle`.
  - Rejected for embed/decay due to cost and lifecycle mismatch (see ADR 0004).
