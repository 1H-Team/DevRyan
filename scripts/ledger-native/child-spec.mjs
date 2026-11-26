// The outcome cases of the child-process differential test
// (child-differential.mjs): each is one child, spawned, fed, read and
// killed the way the ledger's Git runner (`session-changes-git.js` `start`,
// `git`, `gitTokens`) or its persistent reader does, run to its end on every
// arm; the record of each is compared (child-js-arm.mjs `cases`, its Rust
// twin `ledger-native-probe child-cases`).
//
// A case: `{ name, file, args, cwd, env, stdio, input, stdout, stderr, kill,
// loose }`.
//   file, args      the program and its arguments; `sh` is found on PATH; a
//                   file `./x` is the arm's scratch file `x` (made by `files`)
//   cwd             a directory (`./` is the arm's scratch, `/nonexistent…`
//                   missing, '' none)
//   env             [[key, value], …] in order, after PATH (`noPath`: no PATH
//                   at all); `<dir>` in a value is the arm's scratch directory
//   stdio           three of 'pipe' | 'ignore' (default all 'pipe')
//   input           'none' (stdin left open) | 'end' | { pipe: text } | { pipeBytes: n }
//                   | { gen: [text, …], throwAt, waitExitAt } (`waitExitAt`: that row
//                   waits for the child's exit) | { write: [text, …], end }
//                   | { writeBytes: [n, …], end } | 'empty'
//   stdout          'data' | 'forAwait' | { forAwait, breakAt } | { forAwait, limit }
//                   | { forAwait, blockMs, watch, total } (each chunk blocks the
//                   loop `blockMs`; the record's `ahead` is how many of the
//                   child's `total` bytes the consumer had not taken when it
//                   first saw the file `watch`) | 'none'
//   stderr          'data' | 'none'
//   kill            [{ at: 'spawn' | 'data' | 'exit' | 'close' | 'timer' | 'finally', signal, ms, check }]
//                   (`check`: a file whose existence is recorded when it fires)
//   destroy         [{ at: 'exit', stream }]: that socket destroyed there
//   reap            a file in the scratch the child wrote a grandchild's pid
//                   to: the arm kills that grandchild (SIGKILL) once the case is over
//   free            run with descriptors taken up to the limit but `free`
//                   (on the arms started under `ulimit -n 256`)
//   descriptors     the child lists its descriptors; each arm records the
//                   ones it held without close-on-exec when it started and
//                   right before the spawn, and the listing is checked per
//                   arm against libuv's rule for this platform
//   loose           record fields left to arrival, compared as a set of
//                   allowed values per arm instead of equal (`writing`: the
//                   codes Electron's Node can give in that situation, each
//                   error object Node's own; a source's events; `ahead`:
//                   its bound; `chunks`: the Rust takes at most that many
//                   times Electron's number of chunks, i.e. reads of Node's
//                   size, 64 KiB, not the 8 KiB a default macOS socket gives)
//   files, dirs     [{ name, text, mode }], [{ name }] made in the arm's scratch first
//   links           [{ name, to }]: symbolic links made there (to a system program:
//                   a script made for the case costs macOS a first-run check)
// The record: whether spawn threw (the error's fields), `typeof pid`, every
// event in arrival order as [source, event, value] (sources: child, stdin,
// stdout, stderr, writing, kill, wcb, loop), stdout's bytes (length, FNV-1a,
// text when short), stderr's text, which stdio streams exist, the stdin
// pipeline's outcome and error object, and the final `exitCode`,
// `signalCode`, `killed`. Compared: each source's events (consecutive `data` collapsed),
// in order, exactly; the cross-source rules (exit before close, every
// output's close before the child's close or right inside it); the rest of
// the record exactly, except the fields a case marks loose.

const sh = (script) => ({ file: 'sh', args: ['-c', script] });

/** This platform's value of `{ darwin, linux }`. */
// What the shell runs when a file has no interpreter line (Linux). It prints
// whether `$0` is absolute and its last segment, never the whole path: each
// arm has its own scratch folder, and the output is compared as bytes.
const PLAIN_SCRIPT = 'case "$0" in /*) printf "absolute|";; *) printf "relative|";; esac\nprintf "%s|" "${0##*/}" "$@"\n';

export const onPlatform = (values) => {
  if (!Object.hasOwn(values, process.platform)) throw new Error(`no value for ${process.platform} in ${JSON.stringify(values)}`);
  return values[process.platform];
};

/**
 * The stdin pipeline's outcomes Electron's Node gives when the child dies
 * with a write waiting, per platform.
 *
 * macOS (measured, research report O2e fix round 1): `EPIPE` almost always;
 * `ECANCELED` when the exit is handled before the socket's failure (the exit
 * destroys the stdin and libuv cancels the write; 4-8 % of runs with four
 * processes at once) and `ENOTCONN` from the write itself (under 1 %).
 *
 * Linux (inferred from the kernel and libuv, not yet measured: the first
 * Linux run passed these situations under the macOS sets without saying
 * which value it saw; the differential now prints every arm's value in an
 * information line): `EPIPE`, and `ECANCELED` when the exit comes first in
 * libuv's batch. No `ENOTCONN`: a socket pair's surviving end keeps its peer
 * after the peer is released, so `write(2)` fails with `EPIPE` (the peer's
 * release shuts the survivor's sending side down).
 *
 * Never a premature close: end-of-stream reports the stream's `errored`
 * first.
 */
const PENDING_WRITE_LOST = Object.freeze(onPlatform({ darwin: ['EPIPE', 'ECANCELED', 'ENOTCONN'], linux: ['EPIPE', 'ECANCELED'] }));
/** A child that closes its stdin and lives on: nothing cancels the write (macOS measured, Linux as above). */
const STDIN_CLOSED = Object.freeze(onPlatform({ darwin: ['EPIPE', 'ENOTCONN'], linux: ['EPIPE'] }));
/** A signal Node's `signo_string` does not name, which the child dies of. */
const UNNAMED_SIGNAL = onPlatform({ darwin: 7, linux: 34 });
/**
 * Lists the child's descriptors (one number a line, ascending as the glob
 * sorts them) without the listing's own: the glob's directory descriptor is
 * closed once the glob is expanded, so `[ -e ]` leaves it out. Where the
 * platform can tell (Linux's `/proc`), each one's target goes to stderr for
 * the log.
 */
const LIST_DESCRIPTORS = 'for f in /dev/fd/*; do [ -e "$f" ] && n="$n ${f##*/}"; done; for d in $n; do printf "%s\\n" "$d"; done; '
  + 'if [ -d "/proc/$$/fd" ]; then for d in $n; do printf "%s -> " "$d" >&2; readlink "/proc/$$/fd/$d" >&2; done; fi';
/** The child's three stdio sockets' receive and send buffer sizes, as `getsockopt` reports them (the handles kept open to the end). */
const PERL_BUFFERS = '$| = 1; our @h; for my $fd (0, 1, 2) { open($h[$fd], "+<&=", $fd) or die "fd $fd: $!"; '
  + 'printf "%d rcv=%d snd=%d\\n", $fd, unpack("i", getsockopt($h[$fd], SOL_SOCKET, SO_RCVBUF)), unpack("i", getsockopt($h[$fd], SOL_SOCKET, SO_SNDBUF)); }';
/** The bound on what a child may run ahead of a consumer that does not keep up (backpressure). */
export const AHEAD_BOUND = 768 * 1024;

export const CASES = Object.freeze([
  // The Git runner's shapes (design file 32, section 3.2).
  { name: 'out, err and an exit code (data listeners)', ...sh('printf abc; printf de >&2; exit 3'), stdout: 'data', stderr: 'data', input: 'empty' },
  { name: 'tokens across two writes and a pause (for await)', ...sh('printf "a\\000b\\000"; sleep 0.05; printf "c\\000d"; printf x >&2'), stdout: 'forAwait', stderr: 'data', input: 'empty' },
  { name: 'exit 128 with "not a git repository" on stderr', ...sh('printf "fatal: not a git repository (or any of the parent directories): .git\\n" >&2; exit 128'), stdout: 'forAwait', stderr: 'data', input: 'empty' },
  { name: 'both outputs closed early, the child lives on: close waits for the exit', ...sh('exec >&- 2>&-; sleep 0.15; exit 0'), stdout: 'forAwait', stderr: 'data', input: 'empty' },
  { name: 'a grandchild holds stdout after the exit: close waits for it, and its bytes are read', ...sh('(sleep 0.15; printf late) & printf early; exit 0'), stdout: 'forAwait', stderr: 'data', input: 'empty' },
  { name: 'past the byte limit: the loop throws, stdout is destroyed, SIGKILL in finally', ...sh('head -c 300000 /dev/zero 2>/dev/null; read x'), stdout: { forAwait: true, limit: 100_000 }, stderr: 'data', input: 'none', loose: { out: 'past 100000' },
    kill: [{ at: 'finally', signal: 'SIGKILL' }] },
  { name: 'a timer kills a child that waits (SIGKILL)', ...sh('read line'), stdout: 'forAwait', stderr: 'data', input: 'none', kill: [{ at: 'timer', signal: 'SIGKILL', ms: 100 }] },
  { name: 'break after the first token: the finally kills', ...sh('printf "a\\000"; read x'), stdout: { forAwait: true, breakAt: 0 }, stderr: 'data', input: 'none',
    kill: [{ at: 'finally', signal: 'SIGKILL' }] },
  // The stdin pipeline when its child goes away (start() swallows EPIPE and
  // the premature close only: F1 of the O2e review).
  { name: '1 MiB into a child that exits without reading: EPIPE, ECANCELED or ENOTCONN', ...sh('exit 0'), stdout: 'forAwait', stderr: 'data', input: { pipeBytes: 1 << 20 },
    loose: { writing: PENDING_WRITE_LOST, stdin: true } },
  { name: '1 MiB into a child killed in its spawn event: EPIPE, ECANCELED or ENOTCONN', ...sh('exec sleep 30'), stdout: 'forAwait', stderr: 'data', input: { pipeBytes: 1 << 20 },
    kill: [{ at: 'spawn', signal: 'SIGKILL' }], loose: { writing: PENDING_WRITE_LOST, stdin: true } },
  { name: 'a timer kills a child that never reads its 1 MiB input (the loop must not block in the write)', ...sh('exec sleep 30'), stdout: 'forAwait', stderr: 'data', input: { pipeBytes: 1 << 20 },
    kill: [{ at: 'timer', signal: 'SIGKILL', ms: 100 }], loose: { writing: PENDING_WRITE_LOST, stdin: true } },
  { name: 'a child that closes its stdin and lives on: EPIPE or ENOTCONN (no exit to cancel the write)', ...sh('exec 0<&-; sleep 0.1; printf done'), stdout: 'forAwait', stderr: 'data', input: { pipeBytes: 1 << 20 },
    loose: { writing: STDIN_CLOSED, stdin: true } },
  { name: 'a child that exits while a grandchild holds its stdin: the waiting write is cancelled, ECANCELED (F1)', ...sh('exec 3<&0; sleep 120 >/dev/null 2>&1 & echo $! > gc.pid; exit 0'), cwd: './', reap: 'gc.pid',
    stdout: 'forAwait', stderr: 'data', input: { pipeBytes: 1 << 20 }, loose: { writing: ['ECANCELED'], stdin: true } },
  // The child reads the first row before it exits, so that row's write has
  // gone through and nothing waits when the exit destroys the stdin. (A
  // child that exits at once is situation A: on Linux it is often gone
  // before the first row is written, and that write fails with EPIPE.)
  { name: 'a generator row that waits for the exit: the stdin closes unfinished, a premature close', ...sh('head -c 1 >/dev/null; exit 0'), stdout: 'forAwait', stderr: 'data', input: { gen: ['a', 'b'], waitExitAt: 1 },
    loose: { writing: ['ERR_STREAM_PREMATURE_CLOSE'], stdin: true } },
  { name: 'a missing program: error ENOENT on a tick, close after both outputs', file: 'devryan-o2e-missing-program', args: ['x'], stdout: 'forAwait', stderr: 'data', input: 'empty' },
  // Spawn errors and their objects.
  { name: 'a missing working directory: ENOENT, path is the program', ...sh('exit 0'), cwd: '/nonexistent-devryan-o2e', stdout: 'data', stderr: 'data', input: 'none' },
  { name: 'a file without permission to execute: EACCES', file: './noexec.sh', args: [], files: [{ name: 'noexec.sh', text: '#!/bin/sh\nexit 0\n', mode: 0o644 }], stdout: 'data', stderr: 'data', input: 'none' },
  // libuv on macOS spawns with posix_spawn, which runs no shell; on Linux it
  // forks and calls glibc's execvp, which runs the file with /bin/sh: $0 is
  // the path tried, the arguments follow.
  { name: 'an executable without an interpreter line: ENOEXEC is thrown (macOS), /bin/sh runs it (Linux)', file: './plain', args: ['a b', 'c'], files: [{ name: 'plain', text: PLAIN_SCRIPT, mode: 0o755 }], stdout: 'data', stderr: 'data', input: 'none' },
  { name: 'the same found on PATH: ENOEXEC is thrown (macOS), /bin/sh runs the entry\'s path (Linux)', file: 'devryan-o2e-plain', args: ['x'], env: [['PATH', '/nonexistent-devryan-o2e:<dir>/bin']], dirs: [{ name: 'bin' }],
    files: [{ name: 'bin/devryan-o2e-plain', text: PLAIN_SCRIPT, mode: 0o755 }], stdout: 'data', stderr: 'data', input: 'none' },
  { name: 'a directory as the program: EACCES', file: './', args: [], stdout: 'data', stderr: 'data', input: 'none' },
  { name: 'at the descriptor limit: EMFILE on a tick, no stdio at all, close(-24) (the Git runner then throws, F2)', ...sh('exit 0'), free: 1, stdout: 'data', stderr: 'data', input: 'none' },
  { name: 'at the descriptor limit, the second socket pair fails: EMFILE, and the first pair is not set up either', ...sh('exit 0'), free: 3, stdout: 'data', stderr: 'data', input: 'none' },
  // The PATH search (uv__spawn_resolve_and_spawn).
  { name: 'PATH searched in order: the first entry that has the program wins (true, not false)', file: 'tool', args: [], env: [['PATH', '<dir>/a:<dir>/b']], dirs: [{ name: 'a' }, { name: 'b' }],
    links: [{ name: 'a/tool', to: '/usr/bin/true' }, { name: 'b/tool', to: '/usr/bin/false' }], stdout: 'data', stderr: 'data', input: 'none' },
  { name: 'PATH whose only entry has a directory named like the program: the EACCES is remembered', file: 'sh', args: [], env: [['PATH', '<dir>/shadow']], dirs: [{ name: 'shadow/sh' }], stdout: 'data', stderr: 'data', input: 'none' },
  { name: 'PATH: a non-executable file first, then the real program (found)', file: 'sh', args: ['-c', 'printf ok'], env: [['PATH', `<dir>/ne:${process.env.PATH ?? '/usr/bin:/bin'}`]], dirs: [{ name: 'ne' }],
    files: [{ name: 'ne/sh', text: '#!/bin/sh\n', mode: 0o644 }], stdout: 'data', stderr: 'data', input: 'none' },
  { name: 'PATH with an empty first entry: the program in the working directory', file: 'devryan-o2e-tool', args: [], cwd: './', env: [['PATH', `:${process.env.PATH ?? '/usr/bin:/bin'}`]],
    links: [{ name: 'devryan-o2e-tool', to: '/usr/bin/false' }], stdout: 'data', stderr: 'data', input: 'none' },
  { name: 'no PATH in the environment: the default search path finds sh', ...sh('printf ran'), noPath: true, env: [['HOME', '/']], stdout: 'data', stderr: 'data', input: 'none' },
  { name: 'PATH: an entry that is a file and nothing else: ENOTDIR is thrown', file: 'sh', args: [], env: [['PATH', '<dir>/afile']], files: [{ name: 'afile', text: 'x', mode: 0o644 }], stdout: 'data', stderr: 'data', input: 'none' },
  // kill.
  { name: 'kill at spawn (true), in exit and in close (false), killed set', ...sh('read line'), stdout: 'data', stderr: 'data', input: 'none',
    kill: [{ at: 'spawn', signal: 'SIGKILL' }, { at: 'exit', signal: 'SIGKILL' }, { at: 'close', signal: 'SIGTERM' }] },
  { name: 'kill(0) of a live child, then SIGTERM when it prints', ...sh('printf ready; read line'), stdout: 'data', stderr: 'data', input: 'none',
    kill: [{ at: 'spawn', signal: 0 }, { at: 'data', signal: 'SIGTERM' }] },
  { name: 'a child that signals itself: SIGTERM', ...sh('kill -TERM $$'), stdout: 'data', stderr: 'data', input: 'none' },
  { name: 'death by a signal Node does not name (SIGEMT on macOS, a real-time one on Linux): exit code 0, no signal', ...sh(`kill -${UNNAMED_SIGNAL} $$; sleep 1; exit 9`), stdout: 'data', stderr: 'data', input: 'none' },
  // stdio, env, cwd.
  // `descriptors`: the listing is checked per arm against libuv's rule, not
  // compared across arms (the arms are different processes): on macOS
  // (POSIX_SPAWN_CLOEXEC_DEFAULT) the child gets 0, 1 and 2 only; on Linux
  // (a fork, no such default) 0, 1, 2 and every descriptor the arm holds
  // without close-on-exec, and the Rust holds none it was not started with.
  { name: 'the child gets its three descriptors and, on Linux only, what this process holds without close-on-exec (design Q5)', ...sh(LIST_DESCRIPTORS), descriptors: true, stdout: 'data', stderr: 'data', input: 'none' },
  { name: 'the child\'s stdio sockets have Node\'s buffer sizes (64 KiB asked for; Linux reports it doubled)', file: 'perl', args: ['-MSocket', '-e', PERL_BUFFERS], stdout: 'data', stderr: 'data', input: 'none' },
  { name: 'stderr ignored (the persistent reader\'s stdio): two closes needed', ...sh('printf x >&2; printf y'), stdio: ['pipe', 'pipe', 'ignore'], stdout: 'data', stderr: 'none', input: 'end' },
  { name: 'the environment in the order given', file: 'env', args: [], env: [['DEVRYAN_O2E_B', 'two'], ['DEVRYAN_O2E_A', 'one'], ['GIT_OPTIONAL_LOCKS', '0']], stdout: 'data', stderr: 'data', input: 'none' },
  { name: 'the environment in JavaScript\'s key order: array-index keys first, ascending; a key given twice keeps its place', file: 'env', args: [],
    env: [['ZZ', '1'], ['7', 'seven'], ['DUP', 'one'], ['10', 'ten'], ['-1', 'neg'], ['01', 'lead'], ['4294967295', 'not an index'], ['4294967294', 'last index'], ['DUP', 'two']], stdout: 'data', stderr: 'data', input: 'none' },
  { name: 'an empty working directory is none: the child starts in this process\'s directory', ...sh('pwd'), cwd: '', stdout: 'data', stderr: 'data', input: 'none' },
  { name: 'the working directory given', ...sh('basename "$(pwd)"'), cwd: './', stdout: 'data', stderr: 'data', input: 'none' },
  { name: 'a relative program found from the working directory\'s PATH entry', file: 'tool', args: ['a b'], cwd: './', env: [['PATH', '.']], files: [{ name: 'tool', text: '#!/bin/sh\nprintf "%s|" "$0" "$@"\n', mode: 0o755 }], stdout: 'data', stderr: 'data', input: 'none' },
  // stdin.
  { name: 'write with a callback, then end: cat echoes it', ...sh('cat'), stdout: 'data', stderr: 'data', input: { write: ['hello', ' world'], end: true } },
  // What each write() returns is Node's rule (the buffered length against
  // the 64 KiB high-water mark, after libuv's one synchronous write(2)), and
  // so depends on how much that one call takes: the socket buffers (the
  // case above). 200,000 bytes is more than either platform's 64 KiB-asked
  // buffer takes at once, so every write returns false on both.
  { name: 'three large writes with callbacks into cat: the two behind the first go as one writev, every callback called', ...sh('cat'), stdout: 'data', stderr: 'data', input: { writeBytes: [200_000, 200_000, 200_000], end: true } },
  { name: 'pipeline of a string into cat (check-ignore\'s input)', ...sh('cat'), stdout: 'forAwait', stderr: 'data', input: { pipe: 'a/\0b/\0c\0' } },
  { name: 'pipeline of a generator into cat (update-index\'s rows)', ...sh('cat'), stdout: 'forAwait', stderr: 'data', input: { gen: ['100644 x\ta\0', '0 y\tb\0', 'z'] } },
  { name: 'pipeline of a generator that throws: writing rejects with it, stdin destroyed with it', ...sh('cat >/dev/null'), stdout: 'forAwait', stderr: 'data', input: { gen: ['a', 'b'], throwAt: 1 } },
  { name: '1 MiB through cat by pipeline: drain, the writer thread, every byte back', ...sh('cat'), stdout: 'forAwait', stderr: 'data', input: { pipeBytes: 1 << 20 } },
  { name: 'an empty pipeline (Readable.from([])): stdin finishes at once', ...sh('cat; printf done >&2'), stdout: 'forAwait', stderr: 'data', input: 'empty' },
  // stdout shapes.
  { name: '300 KB of output to a data listener', ...sh('head -c 300000 /dev/zero'), stdout: 'data', stderr: 'data', input: 'none' },
  { name: 'output nobody reads: flushStdio drains it at the exit so close comes', ...sh('head -c 20000 /dev/zero; printf e >&2'), stdout: 'none', stderr: 'none', input: 'none' },
  // Backpressure (libuv reads only while the loop polls; past the
  // high-water mark nothing is read): the child is held back.
  { name: 'a consumer that takes each chunk slowly holds the child back: it runs at most the bound ahead', ...sh('head -c 2000000 /dev/zero; : > done'), cwd: './',
    stdout: { forAwait: true, blockMs: 10, watch: './done', total: 2_000_000 }, stderr: 'data', input: 'empty', loose: { ahead: AHEAD_BOUND, chunks: 2 } },
  { name: 'an output nobody reads stops being read at the high-water mark: the child cannot finish before it is killed', ...sh('head -c 2000000 /dev/zero; : > done'), cwd: './',
    stdout: 'none', stderr: 'data', input: 'none', kill: [{ at: 'timer', signal: 'SIGKILL', ms: 200, check: './done' }] },
  { name: 'more than the high-water mark to an unread stdout, killed, stdout destroyed in exit: the parked reader stops', ...sh('exec head -c 3000000 /dev/zero'),
    stdout: 'none', stderr: 'data', input: 'none', kill: [{ at: 'timer', signal: 'SIGKILL', ms: 100 }], destroy: [{ at: 'exit', stream: 'stdout' }] },
]);

/** The extended run's cases: large outputs and inputs (the 64 MiB listing bound's scale). */
export const EXTENDED_CASES = Object.freeze([
  { name: '32 MiB of output through for await (an ls-files-sized listing)', ...sh('head -c 33554432 /dev/zero'), stdout: 'forAwait', stderr: 'data', input: 'empty' },
  { name: '16 MiB through cat by pipeline, read by for await', ...sh('cat'), stdout: 'forAwait', stderr: 'data', input: { pipeBytes: 16 << 20 } },
  { name: '8 MiB of output to a data listener while 1 MiB of stderr arrives', ...sh('head -c 8388608 /dev/zero & head -c 1048576 /dev/zero | tr "\\000" x >&2; wait'), stdout: 'data', stderr: 'data', input: 'none', loose: { err: true } },
]);
