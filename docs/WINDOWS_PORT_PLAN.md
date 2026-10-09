# Windows compatibility preview and native qualification

## Approved preview scope

The first Windows download is a separate experimental prerelease,
`v2.0.3-windows-preview.1`, for x64 and ARM64. It uses stock OpenCode **2.0.20**
with ordinary Windows-user permissions. DevRyan does not maintain Node/Bun
forks for this lane. The unfinished native confinement port remains separate.
Published `v2.0.2`, native admission, and stable release verification are unchanged.

Electron hosts DevRyan's web feature backend in-process. Packaged preview
metadata selects `standard-preview` before native bootstrap imports execute.
The backend starts its own bundled OpenCode process with authenticated loopback
communication and stock `/api/info` readiness. The preview has a separate app
identity and data directory, an explicit capabilities response, and a visible
notice explaining ordinary-user execution. Existing Electron origin, navigation,
and IPC protections still apply.

The supported scope is local projects, validated file operations, API-key
provider configuration, coding conversations, session history, permissions,
questions, SSE, abort, restart and shutdown. OpenCode owns provider credentials;
its ordinary tools may modify files and run commands with the user's permissions.

Both backend routes and UI capabilities disable protected Revert/redo, captured
change history, DevRyan-managed child-task orchestration, native provider
transports, OAuth enrollment, managed Bots, native browser/media helpers and the
integrated terminal. The preview never fabricates confinement or Revert receipts.
Subscription OAuth and advanced native features are follow-up work.

## Packaging and publication

Use native `windows-2022` x64 and `windows-11-arm` ARM64 runners. Pin each official
OpenCode platform archive's integrity and verify its executable's PE architecture;
an installer filename is not architecture evidence. Build per-user NSIS installers
with preview branding and automatic updates disabled. Preview upgrades use a
new downloaded installer.

The separate preview verifier requires exactly these public assets:

- `DevRyan-2.0.3-windows-preview.1-win-x64.exe`
- `DevRyan-2.0.3-windows-preview.1-win-arm64.exe`

It binds source, runtime versions, architectures and hashes to each artifact.
Checksums, tested scenarios, signing status and known limitations belong in the
prerelease notes, without extra public checksum/metadata assets. Stable users
must not be directed to the preview automatically.

[OpenChamber's Windows workflow](https://github.com/openchamber/openchamber/blob/v2.1.1/.github/workflows/release.yml)
is a packaging reference for Electron, bundled OpenCode and per-user NSIS.
DevRyan retains its own backend, branding and release contracts.

## Verification and completion

1. Run `bun run validate:full`, `bun run build` and `bun run bundle:check` on
   the final source, plus focused preview contract tests.
2. On each native Windows runner, perform bounded installation, launch,
   readiness, local project/file access, API-key setup with a disposable provider
   fixture, chat/SSE, history, abort, restart and uninstall checks. Confirm
   unsupported backend routes refuse requests.
3. Fix reproduced startup failures before publishing that architecture.
   Record unavailable checks honestly. LPAC qualification, exhaustive installer
   recovery and paid live-provider testing do not block this experimental lane.
4. Review existing repairs and preview changes in PR #1, fix actionable
   regressions, update its description, complete relevant checks, and merge.
5. Publish the prerelease from the reviewed source and verify its exact assets.

Use **GPT-6.1 Sol with high reasoning** for all subagents: the runtime owner
handles backend composition/lifecycle/adapters, the desktop/release owner handles
Electron and packaging, and the review/test owner handles UI capabilities and
independent checks. Assign disjoint files and preserve other agents' edits.

Before synchronizing primary `main`, coordinate with active writers and retain a
recoverable snapshot of all pre-existing edits. Preserve overlapping edits,
fast-forward `main`, restore the edits, verify restoration, and retain the backup.
These unrelated edits do not belong in preview commits or artifacts.

Re-inventory open PRs before merging. After verifying ancestry, delete
`fix/windows-release`, `hotfix/2.0.1`, `implementation/windows-port` and
`release/2.0.2` from origin. Detach the repair worktree before deleting its local
branch. Preserve unrelated detached worktrees and tags. Completion requires
`main` as the only local/origin branch, merged PRs, and recoverable user work.

## Native qualification status

Native confinement remains unqualified on both Windows architectures. The prior
[run 37612482825](https://github.com/1H-Team/DevRyan/actions/runs/37612482825)
passed supervisor compilation, private-filesystem checks and candidate builds,
but failed supervision and every Node/Bun bootstrap matrix case. This is not
preview qualification evidence. The native lane continues to refuse admission
until its original safety and installer gates pass.

## Qualification history

History: [Windows port qualification history](audits/2026-10-07/windows-port-qualification-history/README.md).

## Filesystem authority

The current policy-3 supervision draft uses a unique LPAC profile and the native
`SECURITY_CAPABILITIES`/All Application Packages opt-out attributes, following
[Microsoft's LPAC launch contract](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer).
It replaces the write-only restricted-SID check. A bounded binary policy binds
the exact view, scratch and cache roots; a cache covering the private runtime
root refuses. The selected executable is copied from a pinned no-follow handle
into a read-only sibling, so its installed ACL is unchanged. Scoped ACLs grant
data access without WRITE_DAC/WRITE_OWNER; OWNER RIGHTS removes implicit owner
WRITE_DAC. Atomic job assignment, all supported UI flags, three inherited handles,
parent creation identity and flushed termination receipts remain mandatory.
The startup diagnostic now executes the exact source on Node and Bun rather
than repeating seven historical source variants. Their original results remain
preserved. Complete runtime/input projection and abrupt-death profile recovery
are still required; no native confinement or startup pass is inferred locally.

Finish engineering before one common source and version freeze for the next
release, publish the qualified macOS asset first, then append both qualified
Windows installers through the existing `desktop` exact asset scope. Preserve
the frozen tag and macOS digest. Provider sign-ins and non-production Supabase
are unavailable currently; their mandatory gates stay pending.

Use Windows handles to inspect owner SID, protected DACL, volume/file identity,
link count, reparse tag, and final path. Private roots must belong to the current
owner and permit only the owner and required system principals. Never infer
privacy from POSIX mode bits on Windows. A missing or unverifiable ACL fails
closed.

Check the opened handle against the inspected path and retain that identity
through reads, writes, locks, and publication. Refuse unexpected hard links,
reparse points, junctions, alternate data streams, device paths, and root swaps.
Canonical comparison must use handle identity and Windows path rules rather
than globally lowercasing strings; preserve Unicode and display spelling.
Directory containment must compare components, not string prefixes. Atomic
replacement and lock recovery must handle sharing violations explicitly.

Required cases: reparse points at every parent and leaf, hard links, case
differences, Unicode and long paths, concurrent replacement, locked files,
read-only files, stale lock holders, and volume changes. Run the same authority
contract against controller state, credential staging, bundle manifests,
recovery receipts, temporary files, and updater intent.

The SDK private lock now uses a reusable protected file, retained byte-range
lock and pinned parents. The shared lock accepts its verified launcher only
through constructor options. Existing bytes and PID values do not establish
ownership; actual kernel exclusion and keeper lifetime do. The helper retains
the real parent process and creation time, permits no file replacement while
held, and acknowledges acquisition only after flushing. Graceful release must
finish before success; forced termination remains unconfirmed. Both architecture
checks and storage/recovery/updater composition remain required. This does not
replace the pending native publication and recovery receipts.

## Execution and process ownership

The native supervisor assigns the owned Job Object atomically during suspended
process creation through `PROC_THREAD_ATTRIBUTE_JOB_LIST`, then resumes it.
Post-creation assignment leaves a supervisor-death race and is prohibited.
This change still needs actual Windows execution evidence. Disable breakaway;
contain every descendant and prevent
child access to the job, parent, policy, cancellation, and receipt handles.
Only the three explicitly selected standard handles are inherited. The private
desktop and token must restrict execution and reads as well as writes. Verify
the approved runtime and library inputs before creating the child.

Bind cancellation and parent-death handling to process handles and creation
times, never a bare PID. A cancellation acknowledgement proves receipt of the
request; a durable termination receipt proves that every descendant settled.
Flush the receipt before reporting termination. A failed or missing receipt
keeps admission held, prevents bundle publication, and requires reconciliation.
Test parent death, descendant escape attempts, handle inheritance, PID reuse,
busy refusal, abrupt supervisor death, cancellation races, and receipt tampering.
The current cancellation implementation captures the owned supervisor's native
creation identity once. The SDK cancellation helper retains that process,
checks the exact identity and original host parent, then opens an event whose
name includes the supervisor PID and creation time. Wrong identities, other
execution events and exited targets refuse. The actual-host verifier adds early
cancellation and descendant heartbeat settlement. Run
[37447349729](https://github.com/1H-Team/DevRyan/actions/runs/37447349729) at
`70831265` passes running-command and early cancellation with flushed receipts
on both architectures. The self-only native descendant also starts and exits
inside the LPAC/job boundary on both. Node descendant setup still fails:
general named-pipe creation returns access denied on both hosts, while the
`LOCAL` namespace succeeds. Windows Server 2022 also refuses `NUL`; Windows 11
ARM64 permits it. The pinned runner Node 22.23.3 source creates its stdio pipes
outside `LOCAL`; the library's newer AppContainer-aware naming does not qualify
the installed build. Preserve the dependency pins and isolation rules while
completing runtime compatibility. Descendant heartbeat settlement, cancellation
of that tree and full runtime admission remain pending.
The process-creation attribute is documented by
[Microsoft](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute).

The controller, writer, and supervisor must execute independently on each
architecture before integrated tests. Credential and enrollment helpers stay
behind their existing private operations. No HTTP or Electron checkpoint export
is introduced by this port.

## Initial capabilities

Persistent PTY, ARM64 Cursor, Bots and background service, and speech are
unavailable initially. Publish these restrictions through runtime capabilities
so the shared UI gives a clear availability state. Keep ordinary configuration,
history, recovery inspection, and installation available where qualified.
Core execution remains unavailable until all safety contracts above pass;
an unsigned installer or successful compile does not enable it.

The persistent-terminal owner now reports a typed unsupported capability on
Windows and rejects HTTP/WS work before backend imports, filesystem access or
environment projection. The shared view waits for this capability before
mounting transport and session owners, and refuses failed or superseded reads.
Bot capability reads grant neither catalog, execution nor management and never
retrieve keys or probe Docker; the Electron manager separately refuses before
construction work. A saved background `service` preference also no longer
projects an enabled service on Windows; the preference remains preserved.
That status error was independently reproduced before correction in
`windows-background-capability-reproduction-1.json`. Existing native speech
and service-registration refusals have focused Windows checks. The native CI
jobs run these guards on each actual architecture and require their outcome;
this does not replace controller, confinement or installer acceptance.

The shared Cursor runtime now exposes an immutable Windows ARM64 refusal and
empty catalogs, preserving saved configuration and history. Verification,
warming, title/text helpers and primary prompts refuse before credential or
admission owners, SDK loads and worker starts. The provider status route does
not inspect credentials for an unsupported host, action routes retain the
typed 503 refusal, and the shared authentication view disables setup and shows
the platform restriction even for a saved key. These checks run on both native
architectures; Windows x64 retains the existing Cursor declaration behavior.

## Packaging and updating

Build unsigned, per-user NSIS installers with Windows app ID
`dev.devryan.desktop` and one fixed installer GUID. Preserve the macOS app ID and
all protocol/package compatibility identities. Public names are exactly
`DevRyan-<version>-win-x64.exe` and `DevRyan-<version>-win-arm64.exe`.
The release asset table in `packages/electron/release-assets.mjs` owns naming.

The isolated implementation now declares the Windows app ID, native AppUserModelID,
unsigned NSIS target and exact per-architecture installer names. Its fixed GUID is
`f8140f18-5574-54bc-8df6-bf218619bfba`, the pinned builder's deterministic GUID
for `dev.devryan.desktop`; do not change it for later upgrades. Installation is
per-user, cannot request elevation, and does not auto-launch at Finish. The owner
controls relaunch after update validation. Source configuration is not installer
qualification: Windows native preparation, resource selection, safety acceptance
and actual installer/update launches still remain outstanding.

Windows updating shares verified release discovery, architecture selection,
resumable downloads, SHA-256 verification, disk preflight, and durable intent
with the desktop updater. Installation uses the verified per-user NSIS
installer after the owned runtime has drained. Validate installer identity,
destination ownership, and the installed version before acknowledging success.
Keep the previous installation and intent until an isolated next launch proves
readiness; preserve recovery state on interruption or refusal. Do not claim
Authenticode signing for unsigned installers.

## Native publication and updater qualification

`windows-private-files.js` composes the SDK's held private-file reads with
compare-and-swap publication, deletion and quarantine. Each transition retains
the exact parent and file identities, byte hash, size, protected owner/ACL and
same-parent recovery intent. File and namespace flush failures propagate;
POSIX mode bits and an absent numeric PID cannot attest these contracts.
Completed private publication backups and receipts have a bounded native
pruner. It preserves the current recovery intent and removes historical
artifacts only by retained identities, with namespace flushes. Journal append,
rotation, compression and staged clear now use constructor-owned native file
operations; retained executable inventories stream beyond the JSON size bound
and use native tree transitions. These implementations still require actual
Windows architecture and namespace qualification.

The managed orchestration ledger now uses a constructor-owned kernel keeper
and an explicit 64 MiB native read/compare-and-swap contract. Keeper loss fences
mutations; shutdown drains queued writes before confirmed release. Ordinary
private JSON operations retain their 16 MiB ceiling. Bundle cloning uses native
tree-copy identities, and SQLite `VACUUM INTO` retains its exclusively created
output file through native commit. Migration and bundle-harness relocation use
the fixed compiled controller under a native job with pinned artifacts, source
and Git configuration handles. Private source creation, credential seeding and
acknowledgement use their constructor-owned native file operations. Accepted
artifact verification still precedes bootstrap or application storage creation.

These owners and their focused protocol/fixture tests establish the implemented
source contracts. Actual x64 and ARM64 compilation, namespace durability,
Git-backed migration/relocation, SQLite commit, keeper failure/recovery and
credential acknowledgement still require native qualification. In particular,
directory flush support and mutation-directory rename while Git configuration
handles remain held need actual Windows evidence. Existing core admission
remains false; source implementation does not establish platform acceptance or
release readiness.

The Windows updater uses `windows-update-owner.mjs` for private resumable
downloads, installation-tree cloning/renames, version inspection and native
NSIS process ownership. Its standalone bundled helper and copied launcher are
bound by actual file identities and SHA-256 before acknowledgement. The native
owner retains the original host's creation-time handle through drain, creates
NSIS in a containing job, confirms descendant termination, flushes the installed
tree and publishes a durable nonce-bound receipt. Unknown candidate launch or
termination remains held. Recovery observes that receipt and exact backup tree,
waits for its own recovery host to exit, restores the fixed per-user registration
and keeps the intent until a normal launch can finish cleanup. Forced process
termination receipts prove the retained root exited; the separate NSIS job
receipt proves installer descendants settled.

`scripts/qualify-windows-installer.mjs` runs only on disposable GitHub-hosted
Windows runners. It first executes the native private namespace prerequisite,
then independently checks actual supervisor acceptance, all sixteen original
Node/Bun stdio cells and the production native artifact verifier. Missing or
failed prerequisites yield `acceptance:false` and five explicit blocked rows;
the script does not build or execute an installer in that case.

When those prerequisites pass, the driver builds actual unsigned per-user NSIS
installers with the existing Electron resources and bundle closure. Both the
baseline fixture and candidate retain the package version and the same source. The
baseline has an explicit fixture metadata field; it is not an earlier shipped
Windows release. The five cells exercise initial installation plus real app
window/runtime health, acknowledged update readiness, integrity refusal with
unchanged installation, native installer interruption, and restoration after a
successful install loses its helper before candidate launch. Each app uses a
private profile and the production resource/preload paths. A failed cell or
unconfirmed cleanup blocks later cells. Process cleanup uses exact creation
identities rather than process-name or PID-only termination.

The driver refuses an existing fixed-GUID registration or DevRyan shortcut
before any installation. It captures the actual HKCU 64-bit install location,
uninstall identity/version/commands and shortcut targets and compares them
through update and rollback. Registry or shortcut mismatches cannot pass from
a restored app directory alone.

`qualification.json` and sibling `evidence.json` bind the full source byte
inventory, native inputs, exact installer name/size/SHA-256, prerequisites and
all five scenario results. The receipt includes `evidenceSha256` and
`sourceTreeSha256`; only a complete actual run emits `acceptance:true`. CI
uploads that evidence and the exact candidate as
`DevRyan-windows-installer-{x64,arm64}`. Private runtime/browser profiles and
fixture installations are excluded from downloadable qualification artifacts.

## CI and evidence

Architecture jobs use separate native outputs and dependency caches. Each job
records Bun version/revision, host architecture, source commit, lock hash,
artifact digests, safety inventory outcomes, and installer digest. CI has read
permissions and no release, tag, database, npm, image-tag, or notification writes.
Qualification artifacts are evidence; publication is a separate gated step.

Mandatory gates include private filesystem/process contracts, controller and
writer boot, seeded credentials, durable journal roots with verified gaps,
admission/cancellation/Revert/publication ordering, seven lifecycle modes,
wire and actual-runtime UI coverage, CLI persistence/refusal, installation,
update success/refusal/interruption/rollback, and both architecture-specific
installer launches. Reuse the macOS evidence table format and record unavailable
or not-run cells explicitly. Platform signing is unavailable by design; native
execution checks cannot be marked passed from a macOS simulation.

The Windows release follows its matching macOS publication only after both architecture columns
pass their mandatory gates. Until those results exist, Windows remains a port
in qualification.
