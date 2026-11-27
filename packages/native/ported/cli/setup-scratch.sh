#!/bin/sh
# Lays out the scratch repository rust-anything's whole-app commands work in (they read and write
# <repo>/rust/app-cases and <repo>/rust/app), outside the worktree: ${TMPDIR}/ra-cli-repo by default.
# Usage: sh packages/native/ported/cli/setup-scratch.sh [scratch folder]. Refuses an existing folder.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
WT=$(cd "$HERE/../../../.." && pwd)
SCRATCH=${1:-${TMPDIR%/}/ra-cli-repo}
if [ -e "$SCRATCH" ]; then echo "setup-scratch.sh: $SCRATCH exists; choose another folder" >&2; exit 1; fi
mkdir -p "$SCRATCH/rust"
cp "$HERE/gen-inputs.mjs" "$HERE/inputs.jsonl" "$HERE/allowed.txt" "$HERE/seed.sh" "$SCRATCH/"
sed -e "s#^HERE=.*#HERE=$SCRATCH#" -e "s#^WT=.*#WT=$WT#" "$HERE/run.sh" > "$SCRATCH/run.sh"
chmod +x "$SCRATCH/run.sh"
cp -R "$HERE/app-cases" "$SCRATCH/rust/app-cases"
cp -R "$HERE/app" "$SCRATCH/rust/app"
cp -R "$HERE/cli-pure" "$SCRATCH/rust/cli-pure"
echo "$SCRATCH"
