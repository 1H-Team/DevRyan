#!/bin/sh
# Runs inside the test isolation guard ($HOME is the private home) and seeds it from the case's
# working folder before running the command: ./home/ is copied into $HOME; a copied `<name>.b64`
# is also decoded to `<name>` (for bytes JSON cannot carry); ./home.modes lines `<mode> <path>`
# (path relative to $HOME) are applied with chmod. Refuses to run outside the guard.
case "$HOME" in
  */devryan-test/run-*/home) ;;
  *) echo "seed.sh: refused: HOME is not a private test home" >&2; exit 97 ;;
esac
if [ -d ./home ]; then
  cp -R ./home/. "$HOME/"
  find "$HOME" -type f -name '*.b64' | while IFS= read -r encoded; do
    base64 -D -i "$encoded" -o "${encoded%.b64}"
  done
fi
if [ -f ./home.modes ]; then
  while read -r mode relative; do chmod "$mode" "$HOME/$relative"; done < ./home.modes
fi
exec "$@"
