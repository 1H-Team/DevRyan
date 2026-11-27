# Unit ports with rust-anything

`packages/native/ported/` holds Rust ports of single units of `packages/ui/src/sync`, each a
standalone crate made and checked with the `rust-anything` CLI (record what the TypeScript does
under Node, replay it against the Rust, fuzz, gate). `packages/native/ported/MAP.md` lists every
unit with its state and numbers. Nothing in the product calls, loads or ships these crates, and
no unit is switched on: `rust-anything enable`, `setup` and `package` are never run here.

The loop for one unit, from the repository root, with the CLI as `rust-anything` and the Rust
toolchain the repository pins:

```sh
export RA_UI_SRC="$PWD/packages/ui/src"            # the `@/` import alias of the UI
ALIAS="--node-arg=--import=$PWD/scripts/rust-anything/alias.mjs"
C=packages/native/ported/<unit>-rs
rust-anything bridge packages/ui/src/sync <unit>.ts -o "$C"   # then add an empty [workspace] table to $C/Cargo.toml
rust-anything record "$C" --from-tests -- node scripts/test-ui.mjs src/sync/<unit>.test.ts
(cd "$C" && cargo fmt) && rust-anything build "$C" && rust-anything diff "$C"
rust-anything fuzz "$C" --cases 5000 "$ALIAS"
rust-anything gate "$C" "$ALIAS"
node scripts/rust-anything/error-texts.mjs "$C"     # error classes and texts (below)
```

`diff`, `fuzz` and `gate` compare only whether a call threw, not what it threw.
`scripts/rust-anything/error-texts.mjs` replays every recorded case of a crate (no argument: every
crate under `packages/native/ported/`, wrapper crates included) through the original and through
the built module, and judges each recorded throw by where the original threw it (decision CD2):
an error the unit's code constructs (`new Error(...)`, `new TypeError(...)`, a factory doing so)
must match in class and message, or the run fails; an error V8 throws (`Cannot read properties
of ...`, `... is not iterable`, `JSON.parse`) is judged by its throw only, and a different text or
class is reported as information. Each crate keeps its reviewed throw sites in
`error-sources.json`; a product site not listed there fails the run until the file is reviewed and
rewritten with `--write`. The bindings `bridge` generates throw a plain `Error` for every Rust
error, so a V8 `TypeError` always differs in class; a product error of another class than `Error`
cannot match without changing the bindings. A crate that is not built or has no recording is
listed and skipped. A crate whose original Node's type stripping refuses lists the files in its
`ts-overrides.json` (or, for a crate another lane owns, `scripts/rust-anything/ts-overrides.json`);
the checker builds them with Bun into a temp folder and sets `RA_TS_OVERRIDES` (below) itself.

Set `CARGO_TARGET_DIR` to a folder outside the repository. After every `record`, `git status
--short -- packages/ui` must print nothing. A recording over a few megabytes is not tracked (the
crate's `.gitignore` names it); make it again with the `record` line above.

Node's type stripping refuses TypeScript namespaces and constructor parameter properties
(`binary.ts`, `event-batch.ts`), and the Node this repository uses has no
`--experimental-transform-types` (`node: bad option`). For a unit that loads such a file, build
that file as JavaScript with Bun outside the repository and list the pair in `RA_TS_OVERRIDES`;
the alias loader then loads the JavaScript in its place, for `record`, `fuzz` and `gate` alike:

```sh
OUT="${TMPDIR%/}/ra-js"; mkdir -p "$OUT"
(cd packages/ui && bun build src/sync/binary.ts --no-bundle --target=node --format=esm --outfile "$OUT/binary.mjs")
export RA_TS_OVERRIDES="$PWD/packages/ui/src/sync/binary.ts=$OUT/binary.mjs"   # pairs separated by `;`
```

A file with relative imports (`event-batch.ts`) is built without `--no-bundle`. Coverage then
counts the built file, not the TypeScript.

## The devryan CLI (whole app)

`packages/native/ported/cli/` ports the `devryan` CLI (`packages/web/bin/cli.js`) with the whole-app
commands: recorded cases, a front door and one unit; `packages/native/ported/cli/MAP.md` has every
command, its state and the numbers. The CLI manages real things (servers, pid files, signals, the
DevRyan and OpenCode configuration, tunnels, updates), so:

- The original runs only through `packages/native/ported/cli/run.sh`: under
  `scripts/test-isolation-guard.mjs` (private HOME, XDG folders and Git config; DevRyan/OpenCode
  location, endpoint and credential variables removed), and only for the argument vectors in
  `allowed.txt`, which `gen-inputs.mjs` writes with `inputs.jsonl`. Anything else, and no arguments
  at all (that is `serve`), is refused with exit 97. Never add a vector that reaches `serve`, `stop`,
  `restart`, `update`, `enroll-owner`, the tunnel network commands, `tunnel profile add` or a valid
  `runtime bundle resume`; an empty first word and a port-only vector are `serve`.
- Every build runs under the guard too (`--build "node scripts/test-isolation-guard.mjs <binary>"`).
- `app record` and `app front-door` write `<repo>/rust/`, so they run on a scratch repository in the
  OS temp folder, never on the worktree. `app lift`, `app shadow`, `enable`, `setup`, `package`, `go`
  and `mcp` are not run here.

From the repository root, with `rust-anything` and the pinned Rust toolchain on PATH and
`CARGO_TARGET_DIR` outside the repository:

```sh
C="$PWD/packages/native/ported/cli"
(cd "$C" && node gen-inputs.mjs)                    # after editing the vectors: inputs.jsonl, allowed.txt
S=$(sh "$C/setup-scratch.sh")                       # <tmp>/ra-cli-repo: run.sh with absolute paths, rust/{app-cases,app,cli-pure}
rust-anything app record "$S" --inputs "$S/inputs.jsonl" --no-traps --name devryan \
  --normalize 'runroot=/[^ ]*/devryan-test/run-[A-Za-z0-9]+' -- ./run.sh
rust-anything app replay "$S"                       # the original: every case must pass
(cd "$C/app" && RUST_ANYTHING_REPO="$C" cargo build)  # the in-tree front door; it falls back through $C/run.sh
rust-anything app replay "$S" --build "node $PWD/scripts/test-isolation-guard.mjs $CARGO_TARGET_DIR/debug/devryan"
RUST_ANYTHING_UNIT_CLI_PURE=original rust-anything app replay "$S" --build "..."   # unit off: 100% fallback
```

`app record` runs about five cases at once (about 75 MB each). Copy a new recording back with
`cp "$S"/rust/app-cases/*.{toml,stdout,stderr} "$S"/rust/app-cases/rust-anything.json "$C/app-cases/"`.
A front door built inside the scratch repository needs `RA_CLI_PACKAGE_JSON=$PWD/packages/web/package.json`
at build time (the glue reads the version there; in the tree it finds it by path). `app wire` was run
with `--skip-gate`: the unit has no function of `cli.js` to bridge without changing `packages/web`, so
its proof is the replay. Remove the scratch folder and the target folder by their exact paths when done.
