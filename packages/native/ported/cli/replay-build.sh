#!/bin/sh
# The build command for `rust-anything app replay --build`: runs a front-door binary the way run.sh
# runs the original, under the test isolation guard and behind seed.sh, so the binary sees the
# case's fixture home. Without seed.sh the binary reads an empty private home and every fixture case
# that it answers itself (tunnel profile) differs. Usage: --build "sh <this file> <binary>".
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
WT=$(cd "$HERE/../../../.." && pwd)
if [ "$#" -lt 1 ] || [ ! -x "$1" ]; then echo "replay-build.sh: usage: replay-build.sh <front-door binary> [args...]" >&2; exit 97; fi
exec node "$WT/scripts/test-isolation-guard.mjs" sh "$HERE/seed.sh" "$@"
