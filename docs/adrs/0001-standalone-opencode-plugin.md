# ADR 0001: Standalone OpenCode Plugin (No Shared Code With Claude Code Hooks)

- Status: Accepted
- Date: 2026-02-25

## Context

memelord currently implements its behavior via Claude Code (CC) hooks (standalone scripts executed per hook invocation). The proposed work adds an OpenCode (OC) plugin that replicates the same user-visible behavior.

However, CC hooks and OC plugins run in materially different environments:

- CC hooks are short-lived processes invoked via `bun run`, receive JSON on stdin, and communicate via stdout/stderr/exit codes.
- OC plugins are long-lived TypeScript modules loaded into the OpenCode process, keep in-memory state across events, and interact with OpenCode through SDK calls and hook APIs.

Attempting to share code across these contexts would require an abstraction layer over I/O, state, and runtime APIs.

## Decision

Implement the OpenCode plugin as a standalone implementation that does not share runtime code with the existing Claude Code hooks.

- The two implementations live side-by-side and may diverge.
- Small pure algorithms (e.g., correction detection, discovery summary building, failure pattern analysis) may be duplicated.
- Parity is maintained via tests for pure functions, not by enforcing shared code.

## Consequences

- Pros:
  - Avoids a complex abstraction layer over two different runtimes.
  - Enables each integration to evolve independently as OpenCode and Claude Code change.
  - Keeps the OC plugin implementation simple and idiomatic to OpenCode.
- Cons:
  - Some duplication is intentional; behavior can drift between CC and OC over time.
  - Requires explicit parity tests to catch accidental divergence.

## Alternatives Considered

- Share a common library for both CC and OC.
  - Rejected: would require substantial indirection for I/O, lifecycle, and SDK interactions.
- Generate both implementations from a single source.
  - Rejected: increases build/maintenance complexity and reduces debuggability.
