# oc_plan

Investigate the repository plan in `@docs/plans/OPENCODE_PLUGIN_PLAN.md`, determine what is already implemented, then pick one incomplete task (or a small cluster of obviously-related tasks) and execute the work end-to-end. Finish by committing the changes.

## What to do

1. Read `@PLAN.md` carefully.
2. Do light repo research to understand the current state of implementation.
   - Confirm which phases/tasks are already done by inspecting the filesystem and code.
   - Prefer quick signals: existing files in `packages/sdk/src/`, `packages/cli/src/`, `scripts/`, and `test/`.
   - Use targeted searches (symbols, filenames) instead of broad refactors.
3. Identify incomplete tasks.
   - Pick exactly one task by default.
   - You may pick 2-3 tasks only if they are tightly coupled and the combined work is still small.
4. Implement the task(s).
   - Follow existing patterns and style in this repo.
   - Aim for <= 400 lines of code added total, but ignore this limit if it would force a worse design or incomplete implementation.
   - Add/adjust tests when appropriate.
   - Keep changes scoped to the chosen PLAN items.
5. Verify locally.
   - Run the most relevant test/build commands for the area you touched (at minimum, run `bun run build` and `bun test test/` if tests exist).
6. Commit.
   - Stage only files relevant to your work (do not sweep in unrelated working tree changes).
   - Write a commit message that references the PLAN phase/area and explains the intent.
7. Mark off completed items in `PLAN.md`.
   - Check off only the tasks you actually implemented.
   - Include the `PLAN.md` checkbox updates in the same commit.

## Guardrails

- Do not "complete" tasks by editing `PLAN.md` checkboxes unless the implementation is actually done.
- Avoid large-scale renames or drive-by refactors.
- Do not add generated artifacts (e.g. `dist/` contents).
- If you discover multiple possible next tasks, choose the one with the best ratio of impact to effort and lowest risk.
- The PLAN has 8 phases with dependencies — respect ordering (e.g. Phase 3-5 implement hook logic, Phase 6 wires it into `memelord init`, Phase 7 is manual testing, Phase 8 is parity tests). Pick the earliest incomplete phase unless a later phase has no blockers.

## Suggested workflow (recommended)

- Inspect current state:
  - `git status`
  - read `PLAN.md`
  - quick `ls`/`glob` of planned directories (`packages/cli/src/`, `packages/sdk/src/`, `test/opencode-plugin/`)
  - `grep` for planned function names (e.g. `generatePluginSource`, `isOpenCodeToolFailure`, `extractToolSequencesFromOC`, `detectCorrections`, `buildDiscoverySummary`, `hookEmbedDecay`)
- Execute one PLAN task end-to-end:
  - add/modify implementation
  - add/modify tests
  - run `bun run build` / `bun test test/` (or the closest equivalent present in `package.json`)
- Commit with a message like:
  - `implement phase N: <intent>`
  - `test phase N: <intent>`
