#!/usr/bin/env bash
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
release_dir=${1:?Pass a new directory for the built adapters}
mkdir -- "$release_dir"
release_dir=$(cd "$release_dir" && pwd)
export PATH="$HOME/.local/opt/node24/bin:$PATH"

checkout() {
  local url=$1 revision=$2 dest=$3
  git init -q "$dest"
  git -C "$dest" fetch -q --depth=1 "$url" "$revision"
  git -C "$dest" checkout -q --detach FETCH_HEAD
}
checkout https://github.com/plastic-labs/dsh-honcho.git 22c6df79c2d95ced6a92f4a4b5c4ed6d2052eca5 "$release_dir/dsh-honcho"
git -C "$release_dir/dsh-honcho" apply "$here/patches/honcho-live-session.patch"
cp "$here/capture-policy.ts" "$release_dir/dsh-honcho/src/capture-policy.ts"
(cd "$release_dir/dsh-honcho" && npm install --no-audit --no-fund && npm run build && npm run verify:tools)

checkout https://github.com/vectorize-io/hindsight.git c828c7e41527d0c4916cac0ba2b56334fed4a79d "$release_dir/hindsight"
git -C "$release_dir/hindsight" apply "$here/patches/hindsight-agent-created.patch"
cp "$here/capture-policy.ts" "$release_dir/hindsight/hindsight-integrations/coding-agents/src/capture-policy.ts"
(cd "$release_dir/hindsight/hindsight-integrations/coding-agents" &&
  npm ci --no-audit --no-fund && npm run build && npx --no-install vitest run src/dsh.test.ts)
