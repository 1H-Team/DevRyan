# packages/native

The product's Cargo workspace. It pins Rust in `rust-toolchain.toml`, tracks `Cargo.lock`, and has one crate, `crates/front`. Nothing here ships in the app, and nothing in the product starts it.

## devryan-front

`devryan-front` is a loopback pass-through front for `devryan serve`. **It is off by default and not shipped. Only tests and QA lanes use it.** It does two things:

1. **Pass-through.** It listens on a loopback port and forwards every connection to the JavaScript server on another loopback port. It adds, removes and rewrites nothing.
2. **Supervision.** With `--spawn` it starts the server as a child in its own process group, with an environment taken only from a file, and waits for health. It stops the child cleanly, and it makes sure the child goes away if the front dies for any reason.

This is part of row B1 of the refactor plan: the pass-through and the supervision. It does not yet run the startup contract or the QA isolated host through the front, and it does not shadow-compare reads.

Recording and comparing traffic is not in this package. It will be a separate package with its own design. Its recordings will be verification-time files that are made and compared within one run and never leave that run's scratch folder. The earlier attempt is not in the tree.

### Loopback only, and why

The front binds and connects only to `127.0.0.0/8` or `::1`. It refuses any other `--listen` or `--upstream` address, and `--listen` takes port 0 only (a fixed loopback port can bind beside a wildcard socket on the same port and shadow it; the bound address is printed). Six checks in the server read the socket's remote address (research file 25, section 6: `security/direct-local-request.js`, `multi-user/runtime.js`, `preview/proxy-runtime.js`, `browser-cdp/discovery-runtime.js`, `browser-cdp/lease-runtime.js`, `runtime-service/routes.js`). Behind any front, every request reaches the server from 127.0.0.1 and looks local. For a loopback-bound server, whose peers are local anyway, that classification does not change, because the front keeps `Host`, `Origin` and every other header as sent and adds no forwarding header. For a LAN-bound server it would turn a remote peer into the local owner. That is why the front must never face a network, and why it is used only by tests and QA lanes for now.

### How transparency is guaranteed

Each client connection gets its own upstream connection, opened when the client connects and closed when it closes. Each direction is a plain copy loop: bytes are written on as soon as they arrive. Nothing is parsed in order to forward, so nothing can be added, removed, rewritten, merged or reordered, and the front cannot disagree with the server about where a message ends. This holds for request and response heads, fixed, chunked and close-delimited bodies, interim responses, pipelined requests, upgrades and WebSocket frames, and for heads a parser would reject or read two ways (an obsolete folded header, a head over 2 MiB, `Content-Length` beside `Transfer-Encoding`, two `Content-Length` headers that disagree, bare LF line ends). An orderly end is passed on as a half-close and a reset as a reset. A refused upstream connection becomes a reset of the client's connection with no bytes (the client's `connect()` itself succeeds, because the front accepted it). `crates/front/tests/transparency.rs` runs each case directly and through the front, and requires identical bytes on both sides of both runs.

A connection holds two descriptors, one per socket, and two threads, one per direction; both directions and the stop list share each socket. At start `serve` raises its soft limit on open files the way Node does: to the hard limit, or to the highest value the kernel accepts (macOS starts processes from a terminal or launchd with a soft limit of 256 and caps it at `kern.maxfilesperproc`). Without that, two descriptors per connection would stop the front near 120 concurrent connections under that default. The child inherits the raised limit, as a child of Node inherits Node's. If the limit cannot be raised, `serve` prints `open-file-limit-not-raised` on stderr and goes on. When `accept` fails for lack of descriptors, the connection waits in the listen backlog and `serve` prints `accept-failed` on stderr, at most once a second. `transparency.rs` holds 300 connections open at once through the binary started with a soft limit of 256.

### Commands

```
devryan-front serve --listen 127.0.0.1:0 --upstream 127.0.0.1:<port>
devryan-front serve --listen 127.0.0.1:0 --spawn --child-env-file <json> [--child-cwd <dir>] [--child-log <file>]
                    [--health-path /api/health] [--ready-field isOpenCodeReady] [--ready-timeout-ms N] [--stop-grace-ms N]
                    -- <program> <args with {port}>...
```

`serve` refuses an option it does not take, so a misspelt option cannot silently turn something off, and `--child-env-file` fails on a value that is not a string. It prints one JSON object per line on stdout: `ready` (listen and upstream addresses, child and watchdog pids), `child-exited` (the child died; the front then stops), `watchdog-exited` (the watchdog died; the front stops the child, since a `kill -9` of the front would otherwise leave it), `connections-still-open` (a connection had not ended 10 s after the stop) and `stopped` (how the child ended and how many connections were accepted). SIGTERM or SIGINT once it is serving stops it cleanly (code 0). SIGTERM or SIGINT while it waits for the child's health stops the child and exits with code 2, because it never served. SIGHUP is not a stop signal: it ends the front at once, without a clean stop, and the watchdog then stops the child as after a `kill -9` (below). It never prints the child's environment. `watchdog` is the same binary's internal watchdog mode (below).

| Code | When |
|---|---|
| 0 | `serve` stopped cleanly on SIGTERM or SIGINT after its `ready` line |
| 2 | Refused: a bad or unknown option or command (all are read before the child starts), an address that is not loopback, a fixed listen port, a child that could not start, exited before it was healthy or was not healthy within `--ready-timeout-ms`, or SIGTERM or SIGINT before it was healthy (the child is stopped first) |
| 3 | `serve --spawn`: the child or its watchdog died |

`crates/front/tests/transparency.rs` checks the refusals and `crates/front/tests/supervision.rs` checks codes 0, 2 and 3.

### Supervision

`--spawn` starts `<program>` with `env_clear()` plus exactly the variables in `--child-env-file`, in a new process group, with stdin closed. `{port}` in the arguments is replaced by a free loopback port. The front waits until `GET <health-path>` answers 200 and, with `--ready-field`, until that JSON field is `true` (`crates/front/src/http.rs` reads the probe's response head and chunked body; nothing else parses HTTP). A stop sends SIGTERM to the group, then SIGKILL to anything left after `--stop-grace-ms` (default 20 s, because the server's own shutdown can take its full 10 s). When the child dies, its upstream connections end, the front passes that on to each client (an end or a reset), prints `child-exited`, stops accepting, ends the rest of the child's group and exits with code 3; it does not restart the child.

A watchdog process (the same binary, `watchdog`, in its own group) holds the read end of a pipe whose write end only the front holds. When the front dies, `kill -9` included, the kernel closes that pipe. The watchdog then checks that the group leader's whole command line (`ps -ww`) still holds the child's, sends SIGTERM to the group, and sends SIGKILL after the grace period. A clean stop releases the watchdog first. The server's own parent-death watchdogs end its OpenCode host when the server goes. The server is not changed.

`crates/front/tests/supervision.rs` runs the real binary with its own test executable as the child (a small HTTP server with a grandchild): a clean stop on SIGTERM leaves no child, grandchild or watchdog; a `kill -9` of the front leaves none; a child that dies is reported (`child-exited`, exit code 3) and its group goes; a child that never gets healthy is stopped and refused (code 2).

Known limits, left as they are:

- The free port is found before the child binds it, a race another process could win. The child then fails its health check and the front reports it. An `--upstream` port that another server already holds can answer the first health probe before the child fails to bind it; the child usually exits first and the front refuses with code 2.
- The watchdog stops the child's group only if the group leader's command line, as `ps -ww -o command=` shows it, still contains `<program's file name> <arguments>`. A child that replaces itself with another program, or rewrites its process title, no longer matches. The watchdog then touches nothing, so after a `kill -9` of the front, or a SIGHUP (which also ends the front without a clean stop), that child and its group keep running. Homebrew's `python3`, which re-executes `Python.app/Contents/MacOS/Python`, is such a child. The JavaScript server started as `node …/cli.js serve --foreground` or through `bun` is not affected: neither re-executes or rewrites its title, and after a `kill -9` of the front the watchdog stopped the child and its grandchild in under 6 s with either runtime. A clean stop (SIGTERM or SIGINT, or the child's own death) does not depend on the check.
- A stop signals the group by the leader's id after the leader was reaped, which is safe while the group has members.

### Real-server lane

`node scripts/qa/front-lane.mjs [--result <file>] [--keep-artifacts]` builds the front in release mode with the pinned toolchain, into its run's scratch folder, and prepares one private runtime-fixture profile (run root, HOME, XDG folders, TMPDIR, data directory and state root, with the loopback provider fixture, the way `scripts/qa/native-backend-ui-diagnostic.mjs` does), in its run's scratch folder under the OS temp dir. It starts `devryan serve --foreground` under `devryan-front serve --spawn`, with the front inside a private environment the test isolation guard creates for it (`createTestIsolation`). It then sends the same request bytes through the front and directly to the server (directly twice, interleaved):

- `GET /api/health`, a static asset from `packages/web/dist/assets`, and the owner enrolment page `GET /auth/local-owner-bootstrap`. Each must answer 2xx both ways with the same status line and header names. A response is deterministic when the two direct answers agree byte for byte apart from `Date`; then the front's answer must equal them. The asset is compared that way. The enrolment page is compared byte for byte with its per-response nonce and the hash part of its `ETag` masked; its 200 through the front also shows the server's direct-local check passing behind the front. The health body changes between calls, so it is compared by status and header names only.
- the SSE stream `GET /api/global/event`, through the front and directly: the same status and content type, and the same events up to `devryan.subscription-ready`.
- a WebSocket upgrade on `/api/global/event/ws` with a fixed key: the same `101` head byte for byte, the server's `ready` message, a client ping answered by a pong with the same payload, and a close answered by a close.

Last, with an SSE stream open through the front, it kills the child with SIGKILL and checks the behaviour above: `child-exited` with `signal 9`, the open stream ends, `stopped`, exit code 3, the listen port and the server's port refuse connections, the child and the watchdog are gone, and no process the front started is left within 10 s.

The lane records every process it starts, directly or not, while it runs: its descendants by pid and start time, and their process groups other than its own, read from the process table every 400 ms, so a process reparented after its parent died is still found. It ends the same way on success, failure, SIGINT, SIGTERM and SIGHUP: it stops the front (SIGTERM, which stops the server), a running build and the profile, then any recorded process or group still running (SIGTERM, then SIGKILL), and reports in its result what it had to stop and anything that survived. A process it had to stop after a completed run fails the run. It then removes everything it created: its run folder under the OS temp dir (`devryan-qa/front-lane-*`), the test isolation guard's root (`devryan-test/run-*`), and the runtime clone the profile preparation requires under the repository's `.cache` (`.cache/front-lane/<run>`, with the folders it had to create for it). A signal that arrives during that ending does not cut it short; if it is handled before the lane exits, the lane exits with 128 plus its number. On failure the result keeps the end of the server's log and the front's stderr, and both whole logs are kept outside the run folder, beside the result file (`<file>.server.log`, `<file>.front.log`), or without `--result` in `devryan-qa/front-lane-failed-logs-*` under the OS temp dir; the lane prints where. `--keep-artifacts` keeps the whole run folder instead. The build runs with the caller's environment (cargo reads its registry from there); git and the front run with the guard's.

A lane killed with SIGKILL cannot clean up, and nothing bounds what it leaves: the front keeps running and keeps the server running, and the two scratch folders and the runtime clone under `.cache/front-lane` (about 300 MB) stay. Stop the `devryan-front` process (its SIGTERM stops the server) and delete `.cache/front-lane` by hand; until then `validate` fails on the leftover folder. Sweeping stale runs at the next start, and a front that stops when its parent is gone, are left for the package that reworks this lane.

What it does not prove: that every route, body or stream is forwarded faithfully (the Rust tests carry that, on scripted peers), anything about a session, a prompt or the OpenCode host's channels, or the delay the front adds. It uses no credential and never touches the owner's app, data or ports. It is in no gate.

### Gates

- `node scripts/check-native.mjs` runs `cargo fetch --locked`, the licence check, `cargo fmt --all --check`, `cargo clippy --locked --offline --workspace --all-targets -- -D warnings` and `cargo test --locked --offline --workspace` with the pinned toolchain. Without that toolchain it fails with the command that installs it. `--deny` adds `cargo deny check licenses advisories sources` offline, against the advisory database already on the machine (cargo-deny 0.20.2, policy in `deny.toml`).
- `node scripts/check-native.mjs --advisories` runs only `cargo fetch --locked` and `cargo deny --locked check licenses advisories sources` with a freshly fetched RustSec database. It needs cargo-deny `CARGO_DENY_VERSION` (0.20.2): with `CARGO_DENY_ROOT=<dir>` it uses `<dir>/bin/cargo-deny` and installs it there with `cargo install cargo-deny --version 0.20.2 --locked --root <dir>` when it is missing; otherwise it must be on PATH. Advisories ignored on purpose are listed in `deny.toml`'s `[advisories] ignore`, each as `{ id = "RUSTSEC-…", reason = "…" }`; the contract refuses an entry without a reason.
- The licence check (`scripts/check-native-licenses.mjs`) needs nothing beyond cargo: it reads `cargo metadata --locked --format-version 1 --all-features` and fails on any package of the locked graph, the workspace's own included, whose SPDX expression the `[licenses] allow` list of `deny.toml` does not satisfy, or that has no expression. That list is the only policy; cargo-deny reads the same one.
- `bun run validate` runs that check, and the script tests that read this workspace, for any change under `packages/native/`, to `scripts/check-native.mjs` or to `scripts/check-native-licenses.mjs` (`scripts/validate.mjs`, `TREE_READERS` in `scripts/test-select.mjs`). A change only to Markdown here, this file included, runs the contract test without cargo.
- `scripts/check-native.test.mjs` is the contract and needs no Rust. It checks the pin (equal to the ledger core's), the check steps, the missing-toolchain message, exact `=x.y.z` dependency pins taken through the workspace, the tracked lockfile from crates.io only, the licence policy and the licence evaluator (with planted violations), CI's advisory steps, and that every crate is named below.
- `scripts/toolchain-pins.test.mjs` requires every CI Rust install to be the ledger core's or this workspace's install command.
- CI's `static` job runs `node scripts/check-native.mjs`, licence check included, and then the advisory check, on every push, and on a pull request that changes this workspace, its check scripts or `ci.yml`. cargo-deny is built once with the pinned Rust into `~/.cache/devryan-cargo-deny` and kept by `actions/cache`, pinned to the commit of release v6.1.0, under a key that names the cargo-deny release and the Rust; a cache hit restores it in seconds. A new advisory fails the job. The contract (`scripts/check-native.test.mjs`) checks the steps, their order and condition, the pin, the key and the ignore list, so none of it can be dropped silently.
- The packaged app holds nothing from here: this folder is not a workspace package, and the packaging rules forbid Rust sources and Cargo files anywhere (`scripts/packaged-app.config.mjs`).

### Adding a crate that cannot build on Linux

The gate checks the whole workspace (`--workspace`) in CI's Ubuntu job, and the contract requires every member to take its dependencies from the workspace and every workspace dependency to be named below. A throwaway spike (`refactor/2026-11-native-spike`) keeps a different `packages/native/` with the same root files (`Cargo.toml`, `Cargo.lock`, `deny.toml`, `rust-toolchain.toml`, `.gitignore`) and macOS-only GPUI crates. Recorded decision: such a crate joins this workspace without breaking the gate this way:

1. The gate names the crates it checks. `scripts/check-native.mjs` gains a list of members per platform (for example `linux: ['devryan-front']`, `darwin: [...all]`) and passes `-p <crate>` for each to clippy and test instead of `--workspace`; the licence check keeps reading the whole locked graph on every platform, because licences do not depend on the platform.
2. The new crate's platform-only dependencies go under `[target.'cfg(target_os = "macos")'.dependencies]` in its own manifest, taken from `[workspace.dependencies]` like every other, so `cargo metadata` and the lockfile stay one for the workspace.
3. The contract's sentence "nothing here ships, nothing starts it" becomes per crate: each crate's section says whether it ships, and the packaging rule is restated for a shipped one.
4. The merge takes this branch's root files and adds the spike's members and dependencies to them; the spike's own root files are not merged.

### Crates

Each is pinned exactly in `[workspace.dependencies]`, and `deny.toml` checks the licences.

| Crate | Licence | Used for |
|---|---|---|
| `httparse` 1.10.1 | MIT or Apache-2.0 | Parsing the health probe's response head during supervision (never for forwarding); the tests' scripted peers parse request heads with it |
| `libc` 0.2.191 | MIT or Apache-2.0 | `killpg`/`kill` for process groups, `SO_LINGER` for reset closes, the SIGTERM/SIGINT handler, the open-file limit |
| `serde_json` 1.0.154 | MIT or Apache-2.0 | `--child-env-file`, the status lines, the health probe's `--ready-field` |

Pulled in by `serde_json`: `serde_core` 1.0.229, `itoa` 1.0.19, `memchr` 2.8.3 (Unlicense or MIT), `zmij` 1.0.23 (MIT). The lockfile also lists `serde`, `serde_derive`, `proc-macro2`, `quote`, `syn` and `unicode-ident`, which those crates name only under a target no platform matches (a version pin) or an optional feature; nothing here builds them, and the licence check reads them too. There is no async runtime: each connection uses two threads with blocking copies, which keeps forwarding a plain read-then-write. There is also no HTTP framework that re-serialises messages, and no WebSocket library: frames are forwarded as bytes.
