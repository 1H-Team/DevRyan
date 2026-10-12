# Startup release contract

Implementation evidence for the working tree based on commit
`936b5444c00f4445479d352b912313212c0d6f43`. This is not a release qualification receipt.

The production verifier now emits bounded artifact diagnostics without changing
its public failure code or admitting unverified executables. Initial directory
bootstrap waits for native health, cancels obsolete results and retries temporary
502/503 failures. Usable chat also requires the global event subscription ACK.
Failure screens offer Retry and sanitized Copy Diagnostics. Phase timings remain
observations; no verification cache or performance improvement is claimed.

Publication now depends on the final signed DMG's startup receipt. The existing
native benchmark owns that lane, reusing production artifact verification,
compiled acceptance, GUI prerequisites, real renderer readiness and fixture
submission checks. The receipt requires ten scenarios, exact source and artifact
identities, zero journal gaps and complete cleanup. Missing GUI or registration
prerequisites, failed trials and reruns cannot qualify a release.

## Historical investigation and limits

The installed-app incident journal was unavailable within the authorized
repository. The exact reported `native_runtime_artifacts_unverified` cause is
still unproven.

Published, unchanged 2.0.7 and 2.0.8 DMGs were inspected and launched with
synthetic profiles. The first baseline trial failed catalog readiness because
the synthetic HOME lacked a Git boundary. After adding that boundary, the second
trial preserved the fixture conversation, completed a new response and advanced
selection once from revision 1 to 2, retaining the previous bundle. Its journal
gap check returned zero. Both releases used OpenCode 2.0.26 and different native
manifests. The first failure remains recorded; the later diagnostic success is
not acceptance evidence.

The second trial unexpectedly started the copied historical app's background
service through launchd. The process used the normal Electron service-profile
location rather than the private foreground profile. The test-owned processes
subsequently exited, and a launchd check found no remaining service label. No
installed-app files were inspected or deleted; residual service-profile files
outside the repository have not been ruled out. This invalidates the trial as
isolation proof. All unchanged production-app launches now require the disposable
macOS runner before spawning, and launchd receives/restores the same isolated
environment as the foreground. Unexpected surviving registration fails cleanup.

Code inspection found that setup projection dropped explicit service opt-out and
disabled Bot preferences. Those preferences now survive first provisioning,
without copying registration/owner state, and have a deterministic regression.
Historical upgrade fixtures explicitly save their service opt-out again after
baseline setup, before launching the candidate.

An initial compiled trial attempted to create 2.0.7's source-only reviewed asset
as a current target and correctly failed integrity admission. The harness now
keeps the established compiled candidate qualification unchanged; historical
profiles are created by their own released apps in the GUI upgrade lane.

## Verification

See [evidence.json](evidence.json) for the sanitized artifact identities and
command outcomes. `bun run validate:full`, `bun run test:startup` (366 tests),
`bun run build` and `bun run bundle:check` passed. Compiled native qualification
passed all 52 cases, with zero gaps in its three journals and no cleanup failures.
Earlier full-suite runs exposed stale workflow, Windows wrapper, splash injection
and readiness-phase test expectations; those were corrected before the passing
run. Manual Retry now replaces the event subscription even when global bootstrap
previously succeeded, covered by the startup contracts.

Final-DMG GUI/service acceptance is unavailable on this local
workstation: the prerequisite guard requires an ephemeral GitHub-hosted macOS
ARM64 runner. No new candidate has been signed, published or release-qualified.
