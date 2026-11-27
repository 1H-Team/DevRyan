# Rust port of the `devryan` CLI (whole app)

The `devryan` command-line tool (`packages/web/bin/cli.js`, its `openchamber` alias included) ported
the way `rust-anything` 5.0.1 ports a whole CLI: its behaviour recorded from the outside, a Rust front
door that owns the entry point and hands every command it does not answer to the original, and the
commands that need no process, port or network moved into one unit crate, proven by replay. Nothing in the product calls, builds, ships
or installs any of it; the released CLI is `cli.js`, unchanged. No unit is lifted, enabled or packaged.

| Folder | What |
| --- | --- |
| `app-cases/` | 232 recorded cases (`<case>.toml` with the arguments and exit code, `.stdout`, `.stderr`; `<case>.in/` is the working folder of a case with fixture state), `rust-anything.json` (how they were recorded) |
| `app/` | The front door (`app front-door`), binary `devryan`: a clap router, `src/original.rs` runs the original for anything not answered, `src/units/cli_pure.rs` is the glue to the unit |
| `cli-pure/` | The unit: `src/port.rs` (parseArgs and the pure commands), `src/state.rs` (status, logs and tunnel profile, which read the data root; a strict `JSON.parse`; clack's output), `texts/` (help, tunnel help and the three completion scripts, the original's bytes) |
| `run.sh`, `allowed.txt`, `inputs.jsonl`, `gen-inputs.mjs`, `free-pids.txt` | How the original is run: only the vectors `gen-inputs.mjs` lists, under `scripts/test-isolation-guard.mjs`; `gen-inputs.mjs` also holds the fixtures and the pids they use |
| `seed.sh` | Inside the guard: copies a case's `./home` into the private home (`*.b64` decoded, `home.modes` applied), then runs the command; refuses any HOME that is not a private test home |
| `replay-build.sh` | The `--build` of every front-door replay: guard, then `seed.sh`, then the binary |
| `setup-scratch.sh` | Lays out the scratch repository the tool works in (`<tmp>/ra-cli-repo/rust/...`) |

Both crates are standalone (`[workspace]` of their own) and are not members of `packages/native`'s
workspace. How to record and replay safely: `scripts/rust-anything/README.md`, "The devryan CLI".

## Numbers

| Replay (build under the guard) | Passed | Fallback |
| --- | ---: | ---: |
| The original (`app replay`) | 232/232 | - |
| Front door, unit switched off (`RUST_ANYTHING_UNIT_CLI_PURE=original`) | 232/232 | 100.0% (232/232) |
| Front door with `cli-pure` wired | 232/232 | 5.6% (13/232) |

219 cases are answered in Rust, 13 by the original (before fixtures: 163 cases, 133 in Rust, 18.4%
fallback). Every case ran twice when recorded; none was unstable. Normalized: the guard's own line
after a non-zero exit (`[run-root] test-isolation failed; ... keep <tmp>/devryan-test/run-XXXXXX.`) and
the private home in the profile permission warning (`runroot`), the `crypto.randomUUID()` ids
(`uuids`) and the `Date.now()` times (`nowms`) the original makes up for incomplete profiles. Exit
codes, stdout and stderr match byte for byte.

### Fixture state

Cases with a `files` map in `inputs.jsonl` run in a folder holding `home/...`, which `seed.sh` copies
into the private home under the guard (bytes JSON cannot carry come as `<name>.b64`; `home.modes`
sets file modes):

- pid records: unparsable, `0`, negative, empty and non-UTF-8 pids (with and without `.json`), names
  the CLI ignores (`devryan-0.pid`, `devryan-70000.pid`, `devryan-x.pid`), a record that is a folder,
  and records holding pids 99971 and 99973 of processes that are not running (`free-pids.txt`;
  checked free with `ps -p` before recording and before each replay here). The original sends those
  `process.kill(pid, 0)`; a replay can meet a reused pid, and the original then only probes and reads
  (an HTTP probe of record ports 1 and 9, `ps`), never acts on it; the `logs` cases with them use
  `--no-follow`;
- `settings.json`: no port, a string port, `0`, `70000`, malformed, an array (a valid
  `desktopLocalPort` is never recorded: the original would probe it, possibly the developer's app);
- log files: empty, 500 lines, non-UTF-8, rotated (`.log.1`), legacy `openchamber-*.log` (no case
  can read them: `logs` reads a log only for a running instance);
- tunnel profiles: two valid profiles (mode 600 and 644, the second needing trim and lower-case,
  a string origin port, fractional and `-0` times), a mixed store (duplicates, missing fields,
  non-objects, `0x400`/`80`/`1024.5`/`abc` ports, blank id, Unicode), malformed JSON, `profiles` not
  an array, `null`, version 1, no id, no times, non-UTF-8 bytes, the store as a folder, and a legacy
  `cloudflare-managed-remote-tunnels.json` with and without usable entries.

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
| `status` (`--json`, `-q`, `--plain`) with no pid to check and no desktop port | "stopped" | in Rust | 14 | Reads `run/` and `settings.json`; creates `run/` (0700) and removes records with a non-positive pid, as the original does |
| `status` with a record holding a positive pid, a record that is not a plain file, or a desktop port | Checks the instance | falls back | 3 | `process.kill(pid, 0)`, then an HTTP probe of the port and `ps`; the desktop port is probed over HTTP |
| `logs` (`--json`, `--no-follow`, `--all`, `--port`, `--lines`, `-q`) with no pid to check | "No running DevRyan instance found[ on port N]." | in Rust | 13 | As `status`; no log is read on this path |
| `logs` with a positive pid | Checks the instance, then tails its log | falls back | 2 | Signal, probe, `ps`; following a log is the original's |
| `tunnel profile`, `list`, `show`, `remove` of a missing name, errors | Saved managed-remote profiles | in Rust | 44 | Reads the store (permission warning from `stat`), and the legacy file only to see that it has nothing to migrate |
| `tunnel profile` when the store would be rewritten (version not 2, `null`), migrated from the legacy file, or a `--json` profile has a made-up id or time; `remove` of an existing profile | | falls back | 8 | Writes the store, or prints `crypto.randomUUID()`/`Date.now()` values |
| Object-prototype names as commands (`toString`, `constructor`, `valueOf`, `hasOwnProperty`, `isPrototypeOf`, `propertyIsEnumerable`, `toLocaleString`, `__lookupGetter__`, `__lookupSetter__`, `__defineGetter__`, `__defineSetter__`, `__proto__`) | `commands[command](options)`: exit 0 silently, `Object.prototype.__defineGetter__: Expecting function`, or `commands[command] is not a function` | in Rust | 15 | No I/O |
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
- clack output would be coloured (stdout is a terminal, or `FORCE_COLOR` is set); `TERM=linux` gets
  clack's ASCII symbols;
- for `status`, `logs` and `tunnel profile`: the data root is not surely `<HOME>/.config/devryan`
  (an explicit data root, a legacy `~/.config/openchamber`, a HOME that is not normalized), or the
  files hold what the rows above send to the original. Every check is made before anything is
  removed or printed;
- the command is not one of the paths above.
