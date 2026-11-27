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
```

Set `CARGO_TARGET_DIR` to a folder outside the repository. After every `record`, `git status
--short -- packages/ui` must print nothing. A recording over a few megabytes is not tracked (the
crate's `.gitignore` names it); make it again with the `record` line above.
