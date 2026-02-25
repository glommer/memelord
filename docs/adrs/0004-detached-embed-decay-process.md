# ADR 0004: Run Embed/Decay/Cleanup in a Detached Background Process Triggered by session.idle

- Status: Accepted
- Date: 2026-02-25

## Context

In CC, embed/decay/cleanup runs at SessionEnd, when the hook process is invoked at session termination.

In OpenCode:

- There is no reliable SessionEnd event.
- Embedding requires loading a relatively heavy local model (seconds of startup time, additional dependencies).
- Running embedding inline in `session.idle` would block the plugin event loop and could execute repeatedly in multi-turn sessions.

We also need to ensure embedding still happens if the user closes OpenCode shortly after a session goes idle.

## Decision

On each `session.idle` event:

- Spawn a detached `memelord hook embed-decay <sessionId> <dataDir>` process.
- The child sleeps for a configurable delay (default 5 minutes) before embedding pending memories, running decay, and cleaning up session temp files.
- Track the last spawned PID and terminate the previous sleeper process before spawning a new one.

This ensures only the most recent "idle" schedules the expensive embed/decay work, reducing redundant work and avoiding concurrent SQLite access.

## Consequences

- Pros:
  - Survives OpenCode exit (`detached: true` + `unref()`).
  - Avoids blocking the OpenCode plugin thread.
  - Batches work across multiple turns (delay window).
  - PID cancellation reduces redundant wakeups and mitigates SQLite lock contention.
- Cons:
  - Introduces extra processes; operational behavior must be understood during debugging.
  - PID tracking is best-effort: if OpenCode exits, it can no longer cancel sleepers (acceptable by design).
  - Requires the `memelord` binary to be discoverable (PATH or configured).

## Alternatives Considered

- Inline embed/decay in `session.idle`.
  - Rejected: blocks and repeats; can be interrupted by OpenCode exit.
- Single long-lived worker inside the plugin.
  - Rejected: would keep heavy model in memory and complicate plugin lifecycle.
- Cron-like external scheduler.
  - Rejected: adds system-level dependencies and setup.
