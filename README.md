<p align="center">
  <img src="logo.svg" width="200" alt="memelord logo">
</p>

# memelord

Persistent memory for coding agents. Powered by [Turso](https://turso.tech).

## The problem

Coding agents start every session from scratch. They repeat the same mistakes, re-discover the same project patterns, and forget corrections the user gave them yesterday.

## How it works

memelord gives agents a per-project memory that persists across sessions and improves over time through reinforcement learning.

### Memory lifecycle

```
Session starts
  |
  +-- SessionStart hook injects top memories into context
  |
  +-- Agent calls memory_start_task("fix the auth bug")
  |     \-- Vector search retrieves relevant memories
  |         "Auth middleware is in src/middleware/auth.rs, not src/auth/"
  |         "Always run 'make check' before committing"
  |
  +-- Agent works on the task...
  |
  +-- Agent discovers something --> memory_report(type: "insight")
  |     "The ORM uses a VDBE architecture: translate -> bytecode -> execute"
  |
  +-- Agent self-corrects --> memory_report(type: "correction")
  |     "Tried src/config.json but config is actually in .env.local"
  |
  +-- User corrects the agent --> memory_report(type: "user_input")
  |     "We use pnpm, not npm"
  |
  +-- Agent finds a retrieved memory was wrong --> memory_contradict(id)
  |     Deletes the bad memory, optionally stores the correction
  |
  +-- Agent finishes --> memory_end_task(ratings)
  |     Rates each retrieved memory 0-3 (ignored -> directly applied)
  |
  \-- SessionEnd hook embeds new memories and runs weight decay
```

### When memories are stored

| Trigger | Category | How |
|---|---|---|
| Agent self-corrects mid-task | `correction` | Agent calls `memory_report` or auto-detected from transcript |
| User corrects the agent | `user` | Agent calls `memory_report` |
| Agent discovers codebase knowledge | `insight` | Agent calls `memory_report` |
| Expensive exploration (50k+ tokens) | `discovery` | Auto-detected by Stop hook |
| Repeated tool failures (3+ in a session) | `correction` | Auto-detected by Stop hook |

### When memories are retrieved

| Trigger | Method |
|---|---|
| Session starts | Top memories by weight injected via SessionStart hook |
| Task starts | Vector similarity search via `memory_start_task` MCP tool |

### How memories improve

Each memory carries a weight that changes based on feedback:

- Agent rates a memory as useful (score 2-3) -> weight increases
- Agent rates a memory as irrelevant (score 0) -> weight decreases
- Memory goes unused across sessions -> gradual time decay
- Agent flags a memory as wrong -> immediately deleted

Weights update via exponential moving average. Memories that consistently help survive; memories that don't eventually get garbage collected.

## Quick start

### Claude Code plugin

```bash
npm install -g memelord
cd your-project
memelord init
```

Restart Claude Code. That's it.

`memelord init` sets up:
- An MCP server (`.mcp.json`) so the agent can call memory tools
- Hooks in `~/.claude/settings.json` so the agent lifecycle is automatically instrumented
- A `.memelord/` directory for the local database

The hooks handle the heavy lifting. At session start, relevant memories are injected into context. At session end, new memories are embedded and weights are decayed. During the session, tool failures are tracked. The agent just needs to call `memory_start_task` when it begins working and `memory_end_task` when it's done.

### Other agents

`memelord init` also configures:
- `.codex/config.toml` for [Codex](https://github.com/openai/codex)
- `opencode.json` for [OpenCode](https://github.com/opencode-ai/opencode)

These get the MCP server but not hooks (hooks are Claude Code-specific). The MCP tools still work -- the agent just doesn't get automatic lifecycle instrumentation.

## MCP tools

| Tool | Description |
|---|---|
| `memory_start_task` | Retrieve relevant memories for a task via vector search. Call at the start of every task. |
| `memory_report` | Store a correction, user input, or insight. |
| `memory_end_task` | Rate retrieved memories and record task outcome. Call when done. |
| `memory_contradict` | Flag a retrieved memory as wrong and delete it. Optionally store the correction. |
| `memory_status` | Show memory system stats. |

## Hooks

| Event | What it does |
|---|---|
| `SessionStart` | Injects top memories into context, stores session metadata |
| `PostToolUse` | Records tool failures for pattern detection |
| `Stop` | Analyzes transcript for self-corrections and expensive explorations |
| `SessionEnd` | Embeds pending memories, runs weight decay, cleans up session files |

## CLI

```
memelord init [dir]           Set up memelord for a project
memelord serve                Start the MCP server
memelord status               Overview: counts, categories, top memories
memelord memories [category]  List all memories
memelord tasks [n]            Show last N tasks with retrievals
memelord log [n]              Compact timeline of tasks and memory events
memelord search <query>       Semantic search across memories
memelord purge [threshold]    Delete memories below weight
```

## SDK

The SDK has no model dependency -- bring your own embedding function.

```ts
import { createMemoryStore } from "memelord";

const store = createMemoryStore({
  dbPath: ".memelord/memory.db",
  sessionId: "session-1",
  embed: yourEmbedFunction, // (text: string) => Promise<Float32Array>
});

await store.init();

// Retrieve relevant memories
const { taskId, memories } = await store.startTask("Fix the auth bug");

// Store a correction
await store.reportCorrection({
  lesson: "Auth middleware is in src/middleware/auth.rs",
  whatFailed: "Looked in src/auth/",
  whatWorked: "Found it in src/middleware/auth.rs",
});

// End task with ratings
await store.endTask(taskId, {
  tokensUsed: 12000,
  toolCalls: 35,
  errors: 2,
  userCorrections: 1,
  completed: true,
  selfReport: memories.map(m => ({ memoryId: m.id, score: 3 })),
});
```

## Architecture

- **Per-project databases**: Each project gets its own `.memelord/memory.db`. No shared state.
- **Local embeddings**: Uses `Xenova/all-MiniLM-L6-v2` (384-dim, quantized, runs on CPU). No API keys needed.
- **Vector search**: Cosine similarity over Turso's `vector32` type. Full scan (no index needed for small datasets).
- **Bun workspaces**: `memelord` (SDK) and `memelord-cli` (CLI + MCP server) are separate packages.

## License

MIT
