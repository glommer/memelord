#!/bin/bash
# Evaluate SWE-bench patches by running FAIL_TO_PASS tests
# Usage: ./evaluate.sh <results_dir> [limit]

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TASKS_FILE="$SCRIPT_DIR/tasks.json"
DJANGO_REPO="/tmp/swebench-django"
PYTHON="/Users/glaubercosta/.pyenv/versions/3.9.16/bin/python"
RESULTS_DIR="$1"
LIMIT="${2:-20}"

if [ -z "$RESULTS_DIR" ] || [ ! -d "$RESULTS_DIR" ]; then
  echo "Usage: ./evaluate.sh <results_dir> [limit]"
  exit 1
fi

echo "=== SWE-bench Evaluation ==="
echo "Results: $RESULTS_DIR"
echo ""

PYTHONPATH="$DJANGO_REPO" "$PYTHON" << PYEOF
import json, subprocess, os, sys

tasks_file = "$TASKS_FILE"
results_dir = "$RESULTS_DIR"
django_repo = "$DJANGO_REPO"
python_bin = "$PYTHON"
limit = $LIMIT

with open(tasks_file) as f:
    tasks = json.load(f)[:limit]

passed = 0
failed = 0
error = 0

for i, t in enumerate(tasks):
    iid = t["instance_id"]
    short = iid.replace("django__django-", "")
    base_commit = t["base_commit"]
    test_patch = t.get("test_patch", "")
    fail_to_pass = t.get("FAIL_TO_PASS", [])
    if isinstance(fail_to_pass, str):
        fail_to_pass = json.loads(fail_to_pass)

    patch_file = os.path.abspath(os.path.join(results_dir, f"{iid}.patch"))
    if not os.path.exists(patch_file):
        print(f"  [{i+1}] {short}: SKIP (no patch)")
        continue

    with open(patch_file) as f:
        our_patch = f.read().strip()
    if not our_patch:
        print(f"  [{i+1}] {short}: SKIP (empty patch)")
        continue

    # Reset eval directory to base commit
    subprocess.run(["git", "checkout", "--force", base_commit],
                   cwd=django_repo, capture_output=True)
    subprocess.run(["git", "clean", "-fdx", "--quiet"],
                   cwd=django_repo, capture_output=True)

    # Apply our patch (from file to avoid stdin encoding issues)
    r = subprocess.run(["git", "apply", patch_file],
                      cwd=django_repo, capture_output=True, text=True)
    if r.returncode != 0:
        print(f"  [{i+1}] {short}: ERROR (patch failed: {r.stderr.strip()[:100]})")
        error += 1
        continue

    # Apply test patch (write to temp file)
    if test_patch:
        test_patch_file = "/tmp/swebench-test.patch"
        with open(test_patch_file, "w") as tf:
            tf.write(test_patch)
        r = subprocess.run(["git", "apply", test_patch_file],
                          cwd=django_repo, capture_output=True, text=True)
        if r.returncode != 0:
            subprocess.run(["git", "apply", "--reject", test_patch_file],
                          cwd=django_repo, capture_output=True, text=True)

    # Extract test labels
    test_labels = set()
    for test_str in fail_to_pass:
        if "(" in test_str:
            module_part = test_str.split("(")[1].rstrip(")")
            parts = module_part.split(".")
            test_labels.add(parts[0])

    if not test_labels:
        print(f"  [{i+1}] {short}: ERROR (no test labels)")
        error += 1
        continue

    # Run the tests
    test_args = list(test_labels)
    env = os.environ.copy()
    env["PYTHONPATH"] = django_repo
    cmd = [python_bin, "tests/runtests.py", "--settings=test_sqlite", "--parallel=1"] + test_args
    try:
        r = subprocess.run(cmd, cwd=django_repo, capture_output=True, text=True, timeout=120, env=env)
    except subprocess.TimeoutExpired:
        print(f"  [{i+1}] {short}: ERROR (timeout)")
        error += 1
        continue

    output = r.stdout + r.stderr

    if r.returncode == 0:
        print(f"  [{i+1}] {short}: PASS")
        passed += 1
    else:
        # Extract failure info
        fail_lines = [l.strip() for l in output.split("\n") if l.strip().startswith(("FAIL:", "ERROR:"))]
        info = "; ".join(fail_lines[:2]) if fail_lines else f"exit {r.returncode}"
        print(f"  [{i+1}] {short}: FAIL ({info[:120]})")
        failed += 1

print()
total = passed + failed + error
print(f"=== {passed}/{total} resolved ({100*passed/total:.0f}%) | {failed} failed | {error} errors ===")
PYEOF
