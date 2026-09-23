#!/bin/sh
set -eu

test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

origin="$test_root/origin.git"
seed="$test_root/seed"
workspace="$test_root/workspace"
script_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"

git init --bare --initial-branch=main "$origin" >/dev/null
git init --initial-branch=main "$seed" >/dev/null
git -C "$seed" config user.email test@example.invalid
git -C "$seed" config user.name 'AgentHarness workspace test'
printf 'one\n' > "$seed/value.txt"
git -C "$seed" add value.txt
git -C "$seed" commit -m one >/dev/null
git -C "$seed" remote add origin "$origin"
git -C "$seed" push -u origin main >/dev/null

run_prepare() {
  AGENTHARNESS_WORKSPACE_ROOT="$workspace" \
  AGENTHARNESS_WORK_REPOSITORY_URL="$origin" \
  AGENTHARNESS_WORK_REPOSITORY_NAME=sample-repo \
  AGENTHARNESS_WORK_ROLE=test \
  AGENTHARNESS_WORK_BASE_BRANCH=main \
  AGENTHARNESS_WORK_BRANCH=codex/test-workspace \
  GIT_CONFIG_GLOBAL="$test_root/gitconfig" \
    "$script_dir/prepare-workspace.sh"
}

run_prepare >/dev/null
test "$(git -C "$workspace/sample-repo" rev-parse HEAD)" = "$(git -C "$seed" rev-parse HEAD)"
test "$(git -C "$workspace/sample-repo" branch --show-current)" = codex/test-workspace

printf 'two\n' > "$seed/value.txt"
git -C "$seed" commit -am two >/dev/null
git -C "$seed" push >/dev/null
printf 'local work\n' > "$workspace/sample-repo/local.txt"
before_dirty_update="$(git -C "$workspace/sample-repo" rev-parse HEAD)"
run_prepare >/dev/null
test "$(git -C "$workspace/sample-repo" rev-parse HEAD)" = "$before_dirty_update"
test -f "$workspace/sample-repo/local.txt"

rm "$workspace/sample-repo/local.txt"
mkdir -p "$workspace/sample-repo/.pnpm-store"
printf 'generated\n' > "$workspace/sample-repo/.pnpm-store/cache"
run_prepare >/dev/null
test "$(git -C "$workspace/sample-repo" rev-parse HEAD)" = "$(git -C "$seed" rev-parse HEAD)"
test -z "$(git -C "$workspace/sample-repo" status --porcelain)"

echo 'prepare-workspace acceptance passed'
