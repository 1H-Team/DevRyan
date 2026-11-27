#!/bin/sh
# Runs the DevRyan CLI (the original, packages/web/bin/cli.js) under the repository's test isolation
# guard: a private HOME, XDG folders and Git config, every DevRyan/OpenCode location, endpoint and
# credential variable removed. Only the argument vectors in allowed.txt (written by gen-inputs.mjs:
# one per line, each argument followed by a tab) are run; anything else, and no arguments at all
# (that starts the server), is refused with exit 97. setup-scratch.sh writes a copy with absolute paths.
HERE=$(cd "$(dirname "$0")" && pwd)
WT=$(cd "$HERE/../../../.." && pwd)
ALLOWED="$HERE/allowed.txt"
if [ ! -f "$WT/scripts/test-isolation-guard.mjs" ] || [ ! -f "$ALLOWED" ]; then echo "run.sh: refused: guard or allowed.txt not found" >&2; exit 97; fi
if [ "$#" -eq 0 ]; then echo "run.sh: refused: no arguments starts the server" >&2; exit 97; fi
key=$(printf '%s\t' "$@")
if ! printf '%s\n' "$key" | grep -Fxq -f "$ALLOWED"; then
  echo "run.sh: refused: argument vector not in allowed.txt" >&2
  exit 97
fi
exec node "$WT/scripts/test-isolation-guard.mjs" node "$WT/packages/web/bin/cli.js" "$@"
