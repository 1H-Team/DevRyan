# Runtime owner recovery verification — 2026-09-06

## Finding and change

The affected Mac had a zero-byte `runtime-service/owner.v1.lock`. Its saved
recovery proof matched the current boot, despite a reported reboot. The journal
had no matching ownership event or reported gap; Electron's startup log recorded
the failure. The previous recovery proof had already been overwritten, so the
exact changed field on that Mac cannot be established retrospectively.

A controlled reproduction established a code defect: changing only the mount
device number between boot observations rejected the unchanged damaged file
and replaced its pre-reboot proof. The repair now stores a v2 persistent identity
without that device number, migrates complete v1 identities without rewriting
the legacy record, retains current-mount checks before quarantine, and serializes
proof writes with owner mutations. Recovery messages distinguish the reasons
automatic repair remains blocked.

## Automated checks

- Focused ownership/startup suites: **58 passed**, including 22 new regression
  cases for device changes, v1 migration, identity/content changes, malformed
  legacy proofs, unavailable boot UUIDs, symlinks, concurrent claims, quarantine
  and publication failures, and bounded content-free diagnostics.
- `bun run validate:full`: **passed** (workspace lint, type checks, and full
  repository/package suites; final web Vitest suite: 355 files / 3,658 tests).
- `bun run build`: **passed**.
- `git diff --check`: **passed**.
- Documentation validation: **passed**.

## Packaged acceptance

An isolated copy of the installed arm64 Electron app received the freshly bundled
main process. Every existing archive entry was compared: only
`dist-bundle/main.mjs` changed. Native unpacking flags and binaries were retained,
the archive-integrity metadata was regenerated, and the original ad-hoc signature
class was preserved and verified with `codesign --verify --deep --strict`.

A separate QA copy used the repository's existing packaged-host isolation policy
with private data/profile/home/log paths and a deterministic loopback OpenCode
fixture. No live model prompts were sent. The QA wrapper disables automatic
background-service registration and uses the mock keychain; production installs
retain their ordinary entrypoint and integrations.

| Fixture | Result |
| --- | --- |
| Empty owner with same-boot v2 proof | Remained blocked; visible startup message and `reboot_required` diagnostic verified. |
| Empty owner with previous-boot v1 proof and different device number | Quarantined one empty record, preserved v1 proof, acquired one app-bound owner, returned healthy HTTP and the full interface. |
| Empty owner with previous-boot v2 proof | Quarantined one empty record, acquired one app-bound owner, returned healthy HTTP and the full interface. |

The startup error and both recovered interfaces were inspected through native
accessibility; the recovered interface was also visually reviewed. All three
fixture process trees stopped with no remaining process identities. The boot
transitions were simulated with isolated proof records; this verification did
not reboot the physical Mac.

The initial QA packaging attempt failed before application startup because a
renamed bundle name no longer matched its helper app names. Restoring the
original bundle name in the isolated copy resolved that fixture-only failure.

Local, ignored evidence is under `.cache/runtime-owner-fix/`: full build and
validation logs, package hashes, fixture results and cleanup receipts, and
installation/owner checks. No sealed handshake token is included in displayed
evidence or this report.

## Local recovery and installation

The original app and background job were verified stopped. The empty owner,
legacy proof, and bounded startup diagnostics were backed up privately; the
unchanged empty regular file was rechecked under the existing mutation lock and
moved to private quarantine. The original installed app then reopened to its
sign-in screen and later quit cleanly, removing its owner lock.

The tested production candidate replaced the installed app only after signature
and archive-hash verification, retaining the previous app under the ignored
`installed-backup/` directory. The updated app reached its sign-in screen with
HTTP health 200 and one listening runtime matching the owner record.
The updated app then quit cleanly and removed its owner lock; reopening created
a new owner/process, restored HTTP health 200, and returned to the sign-in
screen without `runtime_service_owner_invalid`. Exactly one runtime owned the
listening port after the reopen. The app was left open for the user.

The machine also reports Docker unavailable and a separate desktop-host broker
registration failure. The existing guarded fallback therefore runs the web
runtime in app-bound mode. These independent conditions do not reproduce the
damaged-owner startup error and are not repaired by this change. No settings,
sessions, credentials, deployment keys, or Docker volumes were deleted.
