export interface BenchmarkTask {
  id: string;
  prNumber: number;
  parentCommit: string;
  prompt: string;
  expectedFiles: string[];
  testCommand?: string;
}

const MEMORY_INSTRUCTIONS = `
IMPORTANT — Memory system:
- Before starting, call mcp__memelord__memory_start_task with a description of this task to retrieve any relevant memories from past sessions.
- When you self-correct (tried a wrong approach, then found the right one), call mcp__memelord__memory_report with type "correction", what failed, what worked, and the lesson learned.
- When done, call mcp__memelord__memory_end_task with your metrics (tokens_used, tool_calls, errors, user_corrections=0, completed=true/false) and rate each retrieved memory 0-3.
`;

export const tasks: BenchmarkTask[] = [
  {
    id: "last-insert-rowid",
    prNumber: 5323,
    parentCommit: "49e0df7ebc324d1069a7fed1ce6c2139b53703b0",
    prompt: `You are working on the Turso database — a Rust-based SQLite-compatible database. The codebase is at {workdir}.

Bug report (issue #5280):

When executing UPDATE statements, Turso incorrectly modifies the value returned by last_insert_rowid(). Per SQLite semantics, only INSERT operations should affect last_insert_rowid(). However, after inserting rows (e.g. last_insert_rowid() returns 6), running an UPDATE like \`UPDATE t1 SET val = 'updated' WHERE id = 1\` causes last_insert_rowid() to return 1 instead of 6.

The same problem occurs with UPSERT DO UPDATE — the ON CONFLICT UPDATE path should not change last_insert_rowid() either.

Steps to reproduce:
1. CREATE TABLE t1(id INTEGER PRIMARY KEY, val TEXT);
2. INSERT INTO t1 VALUES(1, 'a'), (2, 'b'), (3, 'c'), (4, 'd'), (5, 'e'), (6, 'f');
3. SELECT last_insert_rowid(); -- returns 6
4. UPDATE t1 SET val = 'updated' WHERE id = 1;
5. SELECT last_insert_rowid(); -- returns 1 (WRONG, should still be 6)

Your task: Find and fix this bug. The fix should:
1. Identify where in the source code UPDATE/UPSERT operations incorrectly update last_insert_rowid
2. Implement a fix that prevents UPDATE/UPSERT from affecting last_insert_rowid
3. Add a regression test

The codebase has these key directories:
- core/translate/ — SQL to bytecode translation (emitter.rs, upsert.rs, etc.)
- core/vdbe/ — Virtual Database Engine that executes bytecode (execute.rs, insn.rs, etc.)
- testing/ — Test infrastructure

${MEMORY_INSTRUCTIONS}`,
    expectedFiles: [
      "core/translate/emitter.rs",
      "core/translate/upsert.rs",
      "core/vdbe/insn.rs",
      "core/vdbe/execute.rs",
    ],
  },
  {
    id: "max-columns",
    prNumber: 5266,
    parentCommit: "6a7f2cd0d43f49fd2816d4bbe5f256572c6032c5",
    prompt: `You are working on the Turso database — a Rust-based SQLite-compatible database. The codebase is at {workdir}.

Bug report (issue #5232):

Turso panics with a TryFromIntError when executing a SELECT query with 32,767 or more columns. The panic occurs at core/vdbe/insn.rs because the column count overflows a u16.

SQLite has a compile-time limit SQLITE_MAX_COLUMN which defaults to 2000 (hard upper bound 32767). Turso should enforce this limit at query compilation time rather than panicking at runtime.

Steps to reproduce:
1. Generate a SELECT with 32767 columns: SELECT 1,1,1,...,1 (32767 times)
2. Turso panics instead of returning an error

Expected behavior: Turso should return an error like "too many columns in result set" when the column count exceeds the limit, just like SQLite does.

Your task: Find and fix this bug. The fix should:
1. Add a column count limit (SQLITE_MAX_COLUMN = 2000) and enforce it during query translation
2. Return a proper error instead of panicking
3. Add a regression test that verifies: 2001 columns fails, 2000 columns succeeds

The codebase has these key directories:
- core/translate/ — SQL to bytecode translation (select.rs handles SELECT)
- core/vdbe/ — Virtual Database Engine
- tests/integration/ — Integration tests

${MEMORY_INSTRUCTIONS}`,
    expectedFiles: [
      "core/translate/select.rs",
    ],
    testCommand: "cargo test test_too_many_columns",
  },
  {
    id: "in-subquery-affinity",
    prNumber: 5214,
    parentCommit: "711c6b9cc62ba3b9bb35fb9666f25893f9654467",
    prompt: `You are working on the Turso database — a Rust-based SQLite-compatible database. The codebase is at {workdir}.

Bug report:

The query \`SELECT '1' IN (SELECT id FROM t)\` returns 0 when it should return 1. This is an affinity handling bug in the IN subquery path.

Steps to reproduce:
1. CREATE TABLE t(id INTEGER PRIMARY KEY);
2. INSERT INTO t VALUES(1);
3. SELECT '1' IN (SELECT id FROM t); -- returns 0 (WRONG, should be 1)

The problem: When materializing the right-hand side of an IN subquery into an ephemeral index and then probing it, Turso doesn't correctly apply SQLite's comparison affinity rules. In SQLite, the IN operator uses a combined affinity derived from both the LHS expression and the RHS subquery result column. When the LHS has no affinity (like a text literal), it should use the RHS column's affinity for the comparison.

Reference: SQLite's exprINAffinity() function computes this combined affinity.

Your task: Find and fix this bug. The fix should:
1. Understand how IN subquery translation works (look at core/translate/expr.rs, core/translate/subquery.rs)
2. Implement proper affinity propagation — compute the combined IN affinity and apply it during both RHS materialization and LHS probing
3. Add a regression test

The codebase has these key directories:
- core/translate/ — SQL to bytecode translation (expr.rs, subquery.rs, compound_select.rs, plan.rs)
- core/vdbe/ — Virtual Database Engine
- parser/src/ast.rs — AST types

${MEMORY_INSTRUCTIONS}`,
    expectedFiles: [
      "core/translate/expr.rs",
      "core/translate/subquery.rs",
      "core/translate/compound_select.rs",
      "core/translate/plan.rs",
      "core/translate/result_row.rs",
      "core/translate/values.rs",
      "parser/src/ast.rs",
    ],
  },
];
