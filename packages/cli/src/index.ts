#!/usr/bin/env bun
import { startMcpServer } from "./mcp.js";
import { resolve, join } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";

const command = process.argv[2];

function getDbPath(): string {
  const dataDir = resolve(process.env.MEMELORD_DIR ?? ".memelord");
  return join(dataDir, "memory.db");
}

/** Open a short-lived connection, run fn, close. */
async function withDb<T>(fn: (db: any) => Promise<T>): T extends never ? never : Promise<T> {
  const { connect } = await import("@tursodatabase/database");
  const dbPath = getDbPath();
  if (!existsSync(dbPath)) {
    console.log("No memelord database found. Run 'memelord init' first.");
    process.exit(0);
  }
  const db = await connect(dbPath);
  await db.exec("PRAGMA busy_timeout = 5000");
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

/**
 * Resolve how to invoke memelord.
 * If installed globally (in node_modules/.bin), just "memelord".
 * Otherwise, use node + absolute path to the built cli.mjs.
 */
function getCliCommand(): { command: string; args: string[] } {
  const execPath = process.argv[1] ?? "";
  if (execPath.includes("node_modules")) {
    return { command: "memelord", args: [] };
  }
  // Not installed globally — use absolute path to this script
  return { command: "node", args: [resolve(execPath)] };
}

function timeAgo(epochSec: number): string {
  const diff = Math.floor(Date.now() / 1000) - epochSec;
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

if (command === "hook") {
  const { runHook } = await import("./hooks.js");
  await runHook(process.argv[3] ?? "");

} else if (!command || command === "serve") {
  await startMcpServer();

} else if (command === "status") {
  await withDb(async (db) => {
    const memCount = (await db.prepare("SELECT COUNT(*) as c FROM memories").get() as any).c;
    const taskCount = (await db.prepare("SELECT COUNT(*) as c FROM tasks WHERE finished_at IS NOT NULL").get() as any).c;
    const avgScore = (await db.prepare("SELECT AVG(task_score) as avg FROM tasks WHERE task_score IS NOT NULL").get() as any).avg;
    const categories = await db.prepare(
      "SELECT category, COUNT(*) as c FROM memories GROUP BY category ORDER BY c DESC"
    ).all() as any[];

    console.log(`memelord status:`);
    console.log(`  Memories:  ${memCount}`);
    console.log(`  Tasks:     ${taskCount}`);
    console.log(`  Avg score: ${avgScore?.toFixed(3) ?? "N/A"}`);
    console.log(`  By category: ${categories.map((r: any) => `${r.category}=${r.c}`).join(", ")}`);

    const topMems = await db.prepare(
      "SELECT content, weight, retrieval_count FROM memories ORDER BY weight DESC LIMIT 5"
    ).all() as any[];

    if (topMems.length > 0) {
      console.log(`\n  Top by weight:`);
      for (const m of topMems) {
        const preview = m.content.length > 70 ? m.content.slice(0, 70) + "..." : m.content;
        console.log(`    [w=${m.weight.toFixed(2)}, used=${m.retrieval_count}x] ${preview}`);
      }
    }
  });

} else if (command === "memories") {
  await withDb(async (db) => {
    const filter = process.argv[3]; // optional category filter

    let query = "SELECT id, content, category, weight, retrieval_count, created_at, length(embedding) as emb_len FROM memories";
    const params: any[] = [];
    if (filter) {
      query += " WHERE category = ?";
      params.push(filter);
    }
    query += " ORDER BY created_at DESC";

    const rows = await db.prepare(query).all(...params) as any[];

    if (rows.length === 0) {
      console.log(filter ? `No ${filter} memories found.` : "No memories found.");
      process.exit(0);
    }

    console.log(`${rows.length} memories${filter ? ` (${filter})` : ""}:\n`);

    for (const r of rows) {
      const embStatus = r.emb_len === 1536 ? "OK" : r.emb_len ? `${r.emb_len}B!` : "pending";
      console.log(`--- [${r.category}] w=${r.weight.toFixed(2)} | used=${r.retrieval_count}x | emb=${embStatus} | ${timeAgo(r.created_at)} ---`);
      console.log(r.content.slice(0, 500));
      if (r.content.length > 500) console.log(`  ...(${r.content.length} chars total)`);
      console.log();
    }
  });

} else if (command === "tasks") {
  await withDb(async (db) => {
    const limit = parseInt(process.argv[3] ?? "10");

    const rows = await db.prepare(`
      SELECT id, description, tokens_used, tool_calls, errors, user_corrections,
             completed, task_score, started_at, finished_at
      FROM tasks
      ORDER BY started_at DESC
      LIMIT ?
    `).all(limit) as any[];

    if (rows.length === 0) {
      console.log("No tasks found.");
      process.exit(0);
    }

    console.log(`Last ${rows.length} tasks:\n`);

    for (const t of rows) {
      const status = t.finished_at
        ? (t.completed ? "completed" : "failed")
        : "in-progress";
      const score = t.task_score != null ? t.task_score.toFixed(3) : "N/A";
      const desc = (t.description || "").slice(0, 100);
      const when = t.started_at ? timeAgo(t.started_at) : "?";

      console.log(`[${status}] score=${score} | ${t.tokens_used ?? "?"}tok, ${t.tool_calls ?? "?"}calls, ${t.errors ?? 0}err, ${t.user_corrections ?? 0}corr | ${when}`);
      console.log(`  ${desc}`);

      const retrievals = await db.prepare(`
        SELECT r.memory_id, r.similarity, r.self_report, r.credit,
               substr(m.content, 1, 80) as preview, m.category
        FROM memory_retrievals r
        JOIN memories m ON r.memory_id = m.id
        WHERE r.task_id = ?
      `).all(t.id) as any[];

      if (retrievals.length > 0) {
        for (const r of retrievals) {
          const rated = r.self_report != null ? ` rated=${r.self_report}/3` : "";
          const credit = r.credit != null ? ` credit=${r.credit.toFixed(2)}` : "";
          console.log(`    -> [${r.category}] sim=${(r.similarity ?? 0).toFixed(3)}${rated}${credit} "${r.preview}..."`);
        }
      }

      const created = await db.prepare(`
        SELECT category, substr(content, 1, 60) as preview
        FROM memories WHERE source_task = ?
      `).all(t.id) as any[];

      if (created.length > 0) {
        for (const c of created) {
          console.log(`    <- stored [${c.category}] "${c.preview}..."`);
        }
      }

      console.log();
    }
  });

} else if (command === "log") {
  await withDb(async (db) => {
    const limit = parseInt(process.argv[3] ?? "20");

    const events: { time: number; text: string }[] = [];

    const tasks = await db.prepare(`
      SELECT description, task_score, tokens_used, tool_calls, errors,
             user_corrections, completed, started_at, finished_at
      FROM tasks ORDER BY started_at DESC LIMIT ?
    `).all(limit) as any[];

    for (const t of tasks) {
      const status = t.completed ? "OK" : "FAIL";
      const score = t.task_score != null ? t.task_score.toFixed(2) : "?";
      const desc = (t.description || "").slice(0, 80);
      events.push({
        time: t.started_at,
        text: `TASK [${status}] score=${score} ${t.tokens_used ?? "?"}tok ${t.errors ?? 0}err — ${desc}`,
      });
    }

    const mems = await db.prepare(`
      SELECT content, category, weight, created_at
      FROM memories ORDER BY created_at DESC LIMIT ?
    `).all(limit) as any[];

    for (const m of mems) {
      events.push({
        time: m.created_at,
        text: `MEM  [${m.category}] w=${m.weight.toFixed(2)} — ${m.content.slice(0, 80)}`,
      });
    }

    events.sort((a, b) => a.time - b.time);

    console.log("Timeline:\n");
    for (const e of events) {
      console.log(`${timeAgo(e.time).padStart(8)}  ${e.text}`);
    }
  });

} else if (command === "search") {
  const query = process.argv.slice(3).join(" ");
  if (!query) {
    console.error("Usage: memelord search <query>");
    process.exit(1);
  }

  const { createMemoryStore } = await import("memelord");
  const { createEmbedder } = await import("./embedder.js");

  const embed = await createEmbedder();
  const store = createMemoryStore({ dbPath: getDbPath(), sessionId: "cli-search", embed });
  await store.init();

  const result = await store.startTask(query);

  if (result.memories.length === 0) {
    console.log("No relevant memories found.");
  } else {
    console.log(`Top ${result.memories.length} results for "${query}":\n`);
    for (const m of result.memories) {
      console.log(`[${m.category}] score=${m.score.toFixed(3)} w=${m.weight.toFixed(2)}`);
      console.log(`  ${m.content.slice(0, 200)}`);
      console.log();
    }
  }

  await store.close();

} else if (command === "purge") {
  const threshold = parseFloat(process.argv[3] ?? "0.5");
  if (isNaN(threshold)) {
    console.error(`Invalid threshold: ${process.argv[3]}`);
    process.exit(1);
  }
  await withDb(async (db) => {
    const result = await db.prepare("DELETE FROM memories WHERE weight < ?").run(threshold);
    console.log(`Purged ${result.changes} memories below weight ${threshold}`);
  });

} else if (command === "init") {
  // -------------------------------------------------------------------------
  // memelord init — one-shot setup for Claude Code, Codex, OpenCode, and OpenClaw
  // -------------------------------------------------------------------------
  const targetDir = resolve(process.argv[3] ?? ".");
  const cli = getCliCommand();

  // 1. Create .memelord directory
  const dataDir = join(targetDir, ".memelord");
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  // 2. Add .memelord to .gitignore
  const gitignorePath = join(targetDir, ".gitignore");
  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, "utf-8");
    if (!content.includes(".memelord")) {
      writeFileSync(gitignorePath, content.trimEnd() + "\n.memelord/\n");
      console.log("  Updated .gitignore");
    }
  } else {
    writeFileSync(gitignorePath, ".memelord/\n");
    console.log("  Created .gitignore");
  }

  // 3. Claude Code — .mcp.json
  const mcpJsonPath = join(targetDir, ".mcp.json");
  let mcpConfig: any = {};
  if (existsSync(mcpJsonPath)) {
    try { mcpConfig = JSON.parse(readFileSync(mcpJsonPath, "utf-8")); } catch {}
  }
  if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};
  mcpConfig.mcpServers.memelord = {
    command: cli.command,
    args: [...cli.args, "serve"],
    env: { MEMELORD_DIR: join(targetDir, ".memelord") },
  };
  writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2) + "\n");
  console.log("  Wrote .mcp.json (Claude Code)");

  // 4. Codex — .codex/config.toml
  const codexDir = join(targetDir, ".codex");
  if (!existsSync(codexDir)) mkdirSync(codexDir, { recursive: true });
  const codexTomlPath = join(codexDir, "config.toml");
  let codexContent = "";
  if (existsSync(codexTomlPath)) {
    codexContent = readFileSync(codexTomlPath, "utf-8");
  }
  if (!codexContent.includes("[mcp_servers.memelord]")) {
    const codexArgs = [...cli.args, "serve"].map(a => `"${a}"`).join(", ");
    codexContent += `
[mcp_servers.memelord]
command = "${cli.command}"
args = [${codexArgs}]
env = { MEMELORD_DIR = "${join(targetDir, ".memelord")}" }
enabled = true
`;
    writeFileSync(codexTomlPath, codexContent.trimStart());
    console.log("  Wrote .codex/config.toml (Codex)");
  } else {
    console.log("  .codex/config.toml already has memelord");
  }

  // 5. OpenCode — opencode.json
  const opencodePath = join(targetDir, "opencode.json");
  let opencodeConfig: any = {};
  if (existsSync(opencodePath)) {
    try { opencodeConfig = JSON.parse(readFileSync(opencodePath, "utf-8")); } catch {}
  }
  if (!opencodeConfig.mcp) opencodeConfig.mcp = {};
  opencodeConfig.mcp.memelord = {
    type: "local",
    command: [cli.command, ...cli.args, "serve"],
    environment: { MEMELORD_DIR: join(targetDir, ".memelord") },
    enabled: true,
  };
  writeFileSync(opencodePath, JSON.stringify(opencodeConfig, null, 2) + "\n");
  console.log("  Wrote opencode.json (OpenCode)");

  // 6. OpenClaw — config/mcporter.json
  const mcporterDir = join(targetDir, "config");
  if (!existsSync(mcporterDir)) mkdirSync(mcporterDir, { recursive: true });
  const mcporterPath = join(mcporterDir, "mcporter.json");
  let mcporterConfig: any = {};
  if (existsSync(mcporterPath)) {
    try { mcporterConfig = JSON.parse(readFileSync(mcporterPath, "utf-8")); } catch {}
  }
  if (!mcporterConfig.mcpServers) mcporterConfig.mcpServers = {};
  mcporterConfig.mcpServers.memelord = {
    command: cli.command,
    args: [...cli.args, "serve"],
    env: { MEMELORD_DIR: join(targetDir, ".memelord") },
  };
  writeFileSync(mcporterPath, JSON.stringify(mcporterConfig, null, 2) + "\n");
  console.log("  Wrote config/mcporter.json (OpenClaw)");

  // 7. Claude Code hooks — ~/.claude/settings.json
  const settingsPath = join(process.env.HOME ?? "~", ".claude", "settings.json");
  if (existsSync(settingsPath)) {
    let settings: any = {};
    try { settings = JSON.parse(readFileSync(settingsPath, "utf-8")); } catch {}
    if (!settings.hooks) settings.hooks = {};

    const hookDefs: Record<string, { hookName: string; timeout: number; matcher?: string }> = {
      SessionStart: { hookName: "session-start", timeout: 10 },
      PostToolUse: { hookName: "post-tool-use", timeout: 5, matcher: "*" },
      Stop: { hookName: "stop", timeout: 15 },
      SessionEnd: { hookName: "session-end", timeout: 30 },
    };

    for (const [event, def] of Object.entries(hookDefs)) {
      const cmd = cli.command === "memelord"
        ? `memelord hook ${def.hookName}`
        : `${cli.command} ${cli.args.join(" ")} hook ${def.hookName}`;
      const hookObj: any = {
        hooks: [{ type: "command", command: cmd, timeout: def.timeout }],
      };
      if (def.matcher) hookObj.matcher = def.matcher;

      // Replace any existing memelord hooks, or add new
      const existing: any[] = settings.hooks[event] ?? [];
      const idx = existing.findIndex((h: any) =>
        h.hooks?.some((hh: any) => hh.command?.includes("memelord") || hh.command?.includes("on-session-start") || hh.command?.includes("on-stop"))
      );
      if (idx >= 0) {
        existing[idx] = hookObj;
      } else {
        existing.push(hookObj);
      }
      settings.hooks[event] = existing;
    }

    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    console.log("  Updated ~/.claude/settings.json (hooks)");
  }

  console.log(`\nmemelord initialized in ${targetDir}`);
  console.log("Restart your coding agent to activate.");

} else if (command === "help" || command === "--help") {
  console.log(`memelord - Persistent memory system for coding agents

Usage:
  memelord init [dir]           Set up memelord for a project (Claude Code, Codex, OpenCode, OpenClaw)
  memelord serve                Start the MCP server (default)
  memelord hook <event>         Run a hook (session-start, post-tool-use, stop, session-end)
  memelord status               Overview: counts, categories, top memories
  memelord memories [category]  List all memories (optionally filter by category)
  memelord tasks [n]            Show last N tasks with retrievals and outcomes
  memelord log [n]              Compact timeline of tasks and memory events
  memelord search <query>       Search memories by semantic similarity
  memelord purge [threshold]    Delete memories below weight (default: 0.5)
  memelord help                 Show this help

Quick start:
  cd your-project && memelord init

Categories: correction, user, discovery, insight, consolidated

Environment:
  MEMELORD_DIR       Data directory (default: .memelord in project root)
  MEMELORD_MODEL     Embedding model override`);

} else {
  console.error(`Unknown command: ${command}. Run 'memelord help' for usage.`);
  process.exit(1);
}
