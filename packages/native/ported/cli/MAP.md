# Rust port of the `devryan` CLI (whole app)

The `devryan` command-line tool (`packages/web/bin/cli.js`, its `openchamber` alias included) ported
the way `rust-anything` 5.0.1 ports a whole CLI: its behaviour recorded from the outside, a Rust front
door that owns the entry point and hands every command it does not answer to the original, and the
pure commands moved into one unit crate, proven by replay. Nothing in the product calls, builds, ships
or installs any of it; the released CLI is `cli.js`, unchanged. No unit is lifted, enabled or packaged.

| Folder | What |
| --- | --- |
| `app-cases/` | 163 recorded cases (`<case>.toml` with the arguments and exit code, `.stdout`, `.stderr`), `rust-anything.json` (how they were recorded) |
| `app/` | The front door (`app front-door`), binary `devryan`: a clap router, `src/original.rs` runs the original for anything not answered, `src/units/cli_pure.rs` is the glue to the unit |
| `cli-pure/` | The unit: `src/port.rs` (parseArgs and the pure commands), `texts/` (help, tunnel help and the three completion scripts, the original's bytes) |
| `run.sh`, `allowed.txt`, `inputs.jsonl`, `gen-inputs.mjs` | How the original is run: only the vectors `gen-inputs.mjs` lists, under `scripts/test-isolation-guard.mjs` |
| `setup-scratch.sh` | Lays out the scratch repository the tool works in (`<tmp>/ra-cli-repo/rust/...`) |

Both crates are standalone (`[workspace]` of their own) and are not members of `packages/native`'s
workspace. How to record and replay safely: `scripts/rust-anything/README.md`, "The devryan CLI".

## Numbers

| Replay (build under the guard) | Passed | Fallback |
| --- | ---: | ---: |
| The original (`app replay`) | 163/163 | - |
| Front door, unit switched off (`RUST_ANYTHING_UNIT_CLI_PURE=original`) | 163/163 | 100.0% (163/163) |
| Front door with `cli-pure` wired | 163/163 | 18.4% (30/163) |

133 cases are answered in Rust, 30 by the original. Every case ran twice when recorded; none was unstable. The only varying text is the guard's own line
after a non-zero exit (`[run-root] test-isolation failed; ... keep <tmp>/devryan-test/run-XXXXXX.`),
normalized by `runroot`. Exit codes, stdout and stderr match byte for byte.

## Commands

State: **in Rust** (answered by `cli-pure`), **falls back** (recorded; the original answers through the
front door), **not recorded** (never run, not even under the guard, for the reason given).

| Command / flags | What it does | State | Cases | Why |
| --- | --- | --- | ---: | --- |
| `-v`, `--version` (any command, `--json`) | Prints package.json's version, before anything else | in Rust | 10 | Pure. The glue reads `packages/web/package.json` |
| `-h`, `--help` (any command; `tunnel ...` gets the tunnel help) | Prints the help | in Rust | 18 | Pure text |
| `tunnel`, `tunnel help` | Tunnel help | in Rust | 3 | Pure text |
| Removed flags (`--try-cf-tunnel`, `--tunnel-qr`, `--tunnel-password-url`, `--tunnel[-provider\|-mode\|-config\|-token\|-hostname]`), unknown options, `--expected-revision` outside `runtime` | Errors, exit 1 (text or `--json`) | in Rust | 30 | Pure |
| Parser errors: `--port`/`-p`, `--host`, `--origin-port` missing, invalid or out of range | `TunnelCliError`, exit 2 | in Rust | 33 | Pure; JS `trim`, `parseInt`, `Number#toString` kept |
| Unknown command (with `Did you mean`) | Error, exit 2 (text or `--json`) | in Rust | 12 | Pure; edit distance over UTF-16 units |
| `tunnel <unknown>` | Error, exit 2 | in Rust | 5 | Pure |
| `tunnel completion [bash\|zsh\|fish\|<other>]` | Completion script or error | in Rust | 10 | Pure text |
| `runtime ...` refused by its checks (`bundle_command_invalid`, `bundle_selection_revision_conflict`) | Error code, exit 2 | in Rust | 12 | Validation before the bundle owner is reached |
| `status` (`--json`, `-q`, `--plain`) | Lists running instances | falls back | 5 | Reads (and creates) `run/` in the data root and the desktop port in settings; recorded only on the empty private root |
| `logs` (`--json`, `--no-follow`, `--all`, `--port`, `--lines`, `-q`) | Tails a running instance's log | falls back | 7 | Reads pid records; recorded only as "No running DevRyan instance found" (no instance, so it never follows) |
| `tunnel profile [list\|show\|remove\|<unknown>]` | Saved managed-remote profiles | falls back | 14 | Reads (and may migrate) the profile store; recorded on the empty store only, `remove` only for a missing name |
| Object-prototype names as commands (`toString`, `constructor`, `hasOwnProperty`, `__proto__`) | `commands[command]` finds `Object.prototype`: exit 0 silently, or `commands[command] is not a function` | falls back | 4 | Traps; left to the original |
| `serve` (and no command at all, an empty first word, any port-only vector such as `--port 8080` or `--port ' 80 '`) | Starts the server (daemon by default) | not recorded | - | Starts a server, writes pid files, opens a port |
| `stop`, `restart` | Signal and restart instances | not recorded | - | Sends signals |
| `update` | Checks GitHub for a newer release | not recorded | - | Network |
| `enroll-owner` | Creates a local-owner enrollment link | not recorded | - | Auth flow, creates a credential |
| `tunnel providers`, `ready`, `doctor`, `status`, `start`, `stop` | Talk to a running instance (default port 3000) | not recorded | - | Network (could reach the developer's running app), start tunnels |
| `tunnel profile add` | Saves a profile with a token | not recorded | - | Writes a credential |
| `runtime bundle resume --expected-revision <N>` (valid) | Resumes a retained runtime bundle | not recorded | - | Changes runtime bundle state |

Through the front door every "not recorded" command falls back to the original as well (the unit
returns no answer for it), but no case exercises it.

## What the unit answers, exactly

`cli_pure::answer(args, context)` mirrors `parseArgs` in full and `main()` up to the command dispatch.
It returns no answer (the original runs) when:

- the arguments are not UTF-8, or package.json's version cannot be read (version only);
- the data-root migration that `main()` runs before help and errors might act: anything but
  "no `~/.config/openchamber`, and either no `~/.config/devryan` or one without
  `.devryan-migration.json`", unless a test runner is detected (`NODE_ENV=test`, `VITEST`,
  `NODE_TEST_CONTEXT`); an explicit `DEVRYAN_DATA_DIR`/`OPENCHAMBER_DATA_DIR` always goes to the original
  (checked: with a legacy folder inside the private root, `--help` falls back and the original migrates);
- an error from `main().catch` would be drawn with clack frames (stdout is a terminal, no `--plain`);
- the command is not one of the pure paths above.
