# Cold web update-check benchmark

`web-update-check-benchmark.mjs` exports `runWebUpdateCheckBenchmark(options)`.
It has no command-line parser. Call it from an ordinary native Node module with
absolute repository paths for `beforeSource`, `afterSource`, and `uiDirectory`.
Optional fields are `outputRoot` (inside repository `.cache`), `label`, and an
`AbortSignal`. Bun, Electron, Windows, forced package-manager selection, a custom
update API, and UI-password environments are rejected by the core validator.
The actual benchmark requires native Node with
[`module.registerHooks`](https://nodejs.org/api/module.html#moduleregisterhooksoptions)
(added in Node 22.15.0 / 23.5.0); the repository's general Node minimum alone is
insufficient. Pure helper imports and tests do not require this API.

The fixed protocol runs three fresh before and three fresh after web hosts in
AB/BA/AB order, using the existing credential-free QA fixture/profile and owned
process helpers. The Node executable, loaded dependency bytes, production
source, scripts, and served UI are recorded and compared. Only the exact
`packages/web/server/lib/package-manager.js` load is replaced, at its original
URL, with one of two pinned source hashes. No source file is overwritten.

Each loaded module records a SHA-256 `fingerprint` of its repository-relative
path (with `/` separators), computed before sanitization, and a `sha256` of its
effective content. Membership and byte comparisons use these two fields;
sanitized `file` labels are diagnostic only and may collide. Duplicate or
missing fingerprints fail validation. The sole changed fingerprint must identify
the exact package-manager path with the pinned before/after content hashes.
Evidence from older runs without fingerprints cannot be graded by this protocol
or repaired by reconstructing sanitized paths; a new frozen study is required.

Each host waits for actual health readiness, fetches the pinned HTML without
executing a renderer, then observes health every 100 ms through a 5-second
warm-up, one cold update request, and a 5-second post-request window. Health
requests never overlap. The update URL is the real web route with
`appType=web&currentVersion=unknown&reportUsage=false`: both pinned sources run
actual local package discovery before returning the same HTTP 200 unknown-
version contract. The explicit unknown version skips variable external release
lookups. Commands execute unchanged against available package-manager installs;
there are no global installs, artificial delays, or global cache clears.

Passive instrumentation records command arguments, timing, exit/error codes,
and output lengths/hashes. It admits only the module's read-only discovery
commands. Exactly one owned update request, actual probes wholly inside that
request, a single module load, and no prior probes are required. V8 sampling and
event-loop delay cover the actual host. Once every timed window ends, CPU
profiling stops before a separately identified cached selection lookup proves
the selected package manager. That lookup's extra metadata probes are excluded
from measurements. CPU sample attribution never subtracts timestamps from a
different monotonic clock.

CPU attribution keeps the raw profile unchanged and follows the timestamp
ordering used by [Chromium DevTools](https://github.com/ChromeDevTools/devtools-frontend/blob/main/front_end/models/cpu_profile/CPUProfileDataModel.ts):
accumulate deltas, stable-sort timestamps together with their sample identities,
weight each sample by the following interval, and use the average interval for
the final sample. Negative raw deltas alone are not incomplete evidence. Missing
or invalid samples, non-finite times, invalid sampled ancestry and profiles with
no measurable interval fail completeness. The receipt reports reordering and
the normalized sampled window separately from wall-clock timing. Older sampled
attribution using raw deltas is not pooled with this protocol.

Every arm retains bounded, sanitized evidence on success or failure, including
health latencies, the CPU profile, diagnostics, fixture activity, post-shutdown
journal inspection, source/dependency identities, and OS ownership audits.
Cleanup audits run after stopping the host and after closing the fixture. A
failed ownership/fixture cleanup preserves the project and prevents subsequent
arms from launching. Any failed arm stops the study after its evidence and
cleanup are recorded. No failed arm is replaced or omitted from the comparison.

The summary reports all six raw arms and per-side median/minimum/maximum for
cold request duration, maximum health latency across warm-up/check/post-check,
maximum event-loop delay from request start through the post-check window, and
V8 samples under the module's synchronous spawn stack. These are descriptive
measurements, not acceptance thresholds. Processes are fresh; OS and package-
manager disk caches remain natural. This focused web-host study does not prove
renderer responsiveness, native recovery, live providers, or managed scheduler
behavior. Run only after other QA/build/test work stops and script/source
identities are frozen.
