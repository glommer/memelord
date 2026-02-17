#!/bin/bash
# SWE-bench Lite benchmark runner for memelord
# Usage: ./run.sh [--with-memelord] [--limit N]

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TASKS_FILE="$SCRIPT_DIR/tasks.json"
DJANGO_REPO="/tmp/swebench-django"
RESULTS_DIR="$SCRIPT_DIR/results"
WITH_MEMELORD=false
LIMIT=10

while [[ $# -gt 0 ]]; do
  case $1 in
    --with-memelord) WITH_MEMELORD=true; shift ;;
    --limit) LIMIT=$2; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

RUN_NAME="run-$(date +%Y%m%d-%H%M%S)"
if $WITH_MEMELORD; then
  RUN_NAME="$RUN_NAME-memelord"
else
  RUN_NAME="$RUN_NAME-baseline"
fi
RUN_DIR="$RESULTS_DIR/$RUN_NAME"
mkdir -p "$RUN_DIR"

echo "=== SWE-bench Lite Benchmark ==="
echo "Run: $RUN_NAME"
echo "Memelord: $WITH_MEMELORD"
echo "Limit: $LIMIT tasks"
echo ""

# Clone Django once if not cached
if [ ! -d "$DJANGO_REPO" ]; then
  echo "Cloning Django..."
  git clone --quiet https://github.com/django/django.git "$DJANGO_REPO"
fi

# Read task IDs and commits
TASK_IDS=()
TASK_COMMITS=()
while IFS=$'\t' read -r id commit; do
  TASK_IDS+=("$id")
  TASK_COMMITS+=("$commit")
done < <(python3 << PYEOF
import json
with open('$TASKS_FILE') as f:
    tasks = json.load(f)[:$LIMIT]
for t in tasks:
    print(t['instance_id'] + '\t' + t['base_commit'])
PYEOF
)

TOTAL=${#TASK_IDS[@]}
echo "Running $TOTAL tasks..."
echo ""

# Set up work directory
WORKDIR="/tmp/swebench-workdir"
rm -rf "$WORKDIR"
cp -r "$DJANGO_REPO" "$WORKDIR"

if $WITH_MEMELORD; then
  mkdir -p "$WORKDIR/.memelord"
  mkdir -p "$WORKDIR/.claude"
  cat > "$WORKDIR/.mcp.json" << 'MCPEOF'
{
  "mcpServers": {
    "memelord": {
      "command": "node",
      "args": ["/Users/glaubercosta/memory-system/memelord/dist/cli.mjs", "serve"],
      "env": {}
    }
  }
}
MCPEOF
  cat > "$WORKDIR/.claude/settings.json" << 'SETTEOF'
{
  "permissions": {
    "allow": [
      "mcp__memelord__memory_start_task",
      "mcp__memelord__memory_report",
      "mcp__memelord__memory_contradict",
      "mcp__memelord__memory_end_task",
      "mcp__memelord__memory_status"
    ]
  }
}
SETTEOF
fi

TOTAL_TIME=0

for ((I=0; I<TOTAL; I++)); do
  INSTANCE_ID="${TASK_IDS[$I]}"
  BASE_COMMIT="${TASK_COMMITS[$I]}"
  N=$((I + 1))
  echo "[$N/$TOTAL] $INSTANCE_ID"

  # Checkout the right commit (preserve memelord files)
  cd "$WORKDIR"
  git checkout --quiet --force "$BASE_COMMIT" 2>/dev/null || {
    git fetch --quiet origin "$BASE_COMMIT" 2>/dev/null
    git checkout --quiet --force "$BASE_COMMIT" 2>/dev/null
  }
  git clean -fdx --quiet --exclude=.memelord --exclude=.mcp.json --exclude=.claude --exclude=.cachebro 2>/dev/null

  # Write the problem statement to a temp file (avoids shell escaping)
  python3 << PYEOF
import json
with open('$TASKS_FILE') as f:
    tasks = json.load(f)
for t in tasks:
    if t['instance_id'] == '$INSTANCE_ID':
        with open('/tmp/swebench-prompt.txt', 'w') as out:
            out.write(t['problem_statement'])
            out.write('\n\nFix the issue described above. Do not modify test files.')
        break
PYEOF

  PROMPT=$(cat /tmp/swebench-prompt.txt)
  START_TIME=$(date +%s)

  cd "$WORKDIR"
  claude -p "$PROMPT" --output-format text --permission-mode bypassPermissions \
    > "$RUN_DIR/${INSTANCE_ID}.txt" \
    2> "$RUN_DIR/${INSTANCE_ID}.stderr" || true

  END_TIME=$(date +%s)
  ELAPSED=$((END_TIME - START_TIME))
  TOTAL_TIME=$((TOTAL_TIME + ELAPSED))

  # Capture git diff
  cd "$WORKDIR"
  PATCH=$(git diff 2>/dev/null || true)
  echo "$PATCH" > "$RUN_DIR/${INSTANCE_ID}.patch"

  PATCH_SIZE=${#PATCH}
  echo "  Time: ${ELAPSED}s | Patch: ${PATCH_SIZE} chars"

  # Write prediction in SWE-bench format
  python3 << PYEOF
import json
pred = {
    'instance_id': '$INSTANCE_ID',
    'model_name_or_path': 'claude-code$( $WITH_MEMELORD && echo '-memelord' || true )',
    'model_patch': open('$RUN_DIR/${INSTANCE_ID}.patch').read()
}
with open('$RUN_DIR/predictions.jsonl', 'a') as f:
    f.write(json.dumps(pred) + '\n')
PYEOF

done

echo ""
echo "=== Results ==="
echo "Run: $RUN_NAME"
echo "Tasks: $TOTAL"
echo "Total time: ${TOTAL_TIME}s"
echo "Results: $RUN_DIR/"
echo ""

python3 << PYEOF
import os
run_dir = '$RUN_DIR'
patches = sorted([f for f in os.listdir(run_dir) if f.endswith('.patch')])
non_empty = sum(1 for f in patches if os.path.getsize(os.path.join(run_dir, f)) > 0)
print(f'Patches generated: {non_empty}/{len(patches)}')
for f in patches:
    size = os.path.getsize(os.path.join(run_dir, f))
    status = 'OK' if size > 0 else 'EMPTY'
    print(f'  {f}: {size} bytes [{status}]')
PYEOF

if $WITH_MEMELORD && [ -f "$WORKDIR/.memelord/memory.db" ]; then
  echo ""
  echo "=== Memelord Stats ==="
  cd /Users/glaubercosta/memory-system/memelord
  bun -e "
import { connect } from '@tursodatabase/database';
const db = await connect('$WORKDIR/.memelord/memory.db');
const count = await db.prepare('SELECT COUNT(*) as c FROM memories').get();
const tasks = await db.prepare('SELECT COUNT(*) as c FROM tasks').get();
const mems = await db.prepare('SELECT content, weight, category FROM memories ORDER BY weight DESC LIMIT 10').all();
console.log('Memories:', count.c, '| Tasks:', tasks.c);
for (const m of mems) console.log('  [' + m.category + '] w=' + m.weight.toFixed(2) + ': ' + m.content.slice(0, 100));
db.close();
"
fi
