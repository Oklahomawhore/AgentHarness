#!/bin/sh
set -eu

workspace_root="${AGENTHARNESS_WORKSPACE_ROOT:-/workspace}"
repository_url="${AGENTHARNESS_WORK_REPOSITORY_URL:?AGENTHARNESS_WORK_REPOSITORY_URL is required}"
repository_name="${AGENTHARNESS_WORK_REPOSITORY_NAME:?AGENTHARNESS_WORK_REPOSITORY_NAME is required}"
work_role="${AGENTHARNESS_WORK_ROLE:?AGENTHARNESS_WORK_ROLE is required}"
base_branch="${AGENTHARNESS_WORK_BASE_BRANCH:-main}"
work_branch="${AGENTHARNESS_WORK_BRANCH:-codex/agentharness-mesh-e2e}"

case "$repository_name" in
  *[!A-Za-z0-9._-]*|'')
    echo "invalid AGENTHARNESS_WORK_REPOSITORY_NAME: $repository_name" >&2
    exit 2
    ;;
esac

git check-ref-format --branch "$base_branch" >/dev/null
git check-ref-format --branch "$work_branch" >/dev/null

mkdir -p "$workspace_root"
repository_dir="$workspace_root/$repository_name"

if [ ! -d "$repository_dir/.git" ]; then
  if [ -e "$repository_dir" ]; then
    echo "workspace target exists but is not a Git repository: $repository_dir" >&2
    exit 2
  fi
  git clone "$repository_url" "$repository_dir"
fi

configured_origin="$(git -C "$repository_dir" remote get-url origin)"
if [ "$configured_origin" != "$repository_url" ]; then
  echo "workspace origin mismatch for $repository_dir" >&2
  exit 2
fi
git -C "$repository_dir" fetch --prune origin

git_dir="$(git -C "$repository_dir" rev-parse --absolute-git-dir)"
exclude_file="$git_dir/info/exclude"
for generated_path in '.pnpm-store/' '.tools/' '.venv/'; do
  if ! grep -Fqx "$generated_path" "$exclude_file"; then
    printf '%s\n' "$generated_path" >> "$exclude_file"
  fi
done

if [ -n "$(git -C "$repository_dir" status --porcelain)" ]; then
  echo "workspace has local work; fetched origin without changing the checkout"
else
  if git -C "$repository_dir" show-ref --verify --quiet "refs/heads/$work_branch"; then
    git -C "$repository_dir" switch "$work_branch" >/dev/null
  else
    git -C "$repository_dir" switch --create "$work_branch" "origin/$base_branch" >/dev/null
  fi
  git -C "$repository_dir" branch --set-upstream-to="origin/$base_branch" "$work_branch" >/dev/null
  if ! git -C "$repository_dir" merge --ff-only "origin/$base_branch"; then
    echo "work branch has diverged from origin/$base_branch; keeping local commits" >&2
  fi
fi

git config --global --replace-all safe.directory "$repository_dir"
revision="$(git -C "$repository_dir" rev-parse --short HEAD)"
echo "workspace ready: role=$work_role repo=$repository_name branch=$(git -C "$repository_dir" branch --show-current) revision=$revision path=$repository_dir"
