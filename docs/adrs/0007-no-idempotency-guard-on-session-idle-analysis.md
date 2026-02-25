# ADR 0007: No Idempotency Guard on session.idle Transcript Analysis

- Status: Accepted
- Date: 2026-02-25

## Context

The CC implementation runs its Stop hook on every completed turn and processes the full transcript each time, without a deduplication mechanism.

OpenCode's `session.idle` event similarly fires after each turn. Introducing a processed-turn guard in the OpenCode plugin would reduce duplicate work but could change behavior relative to CC, and it requires a reliable turn identifier (not currently part of the event payload).

## Decision

Mirror the CC behavior:

- Run transcript analysis on every `session.idle` event without an idempotency guard.
- Accept the possibility of duplicate memories (e.g., if the same correction is detected on multiple idle events).

## Consequences

- Pros:
  - Behavioral parity with the existing CC integration.
  - Simple implementation; no dependency on an OpenCode turn/step identity.
- Cons:
  - Potential duplication of stored correction/discovery memories.
  - Extra compute cost as session length grows.

## Alternatives Considered

- Store a last-processed message ID/timestamp and only analyze new messages.
  - Deferred: requires careful handling of edits, tool parts, and replays; adds statefulness and new failure modes.
- Compute a transcript hash and skip if unchanged.
  - Deferred: adds overhead and still requires persistence across plugin reloads.
