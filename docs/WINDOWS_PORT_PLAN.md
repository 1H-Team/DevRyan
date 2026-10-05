# Windows port and qualification

Windows follows the macOS 2.0.2 release. Both architectures must build and run
their own artifacts: x64 on `windows-2022`, ARM64 on `windows-11-arm`.
These are [GitHub hosted runner labels](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
Bun stays at 1.3.14 and dependency versions stay pinned in `bun.lock`.
Cross-compilation is useful for development but cannot qualify either platform.

## Ownership and integration order

The Electron shell remains in `packages/electron`; its in-process web server
remains the feature backend. Native contracts remain in the harness runtime and
`packages/web/server/lib/opencode/runtime-host`. The legacy Tauri package receives
no Windows features. Shared changes follow integration of the macOS inputs,
storage, lifecycle, UX, skills, prompt, journal, and Bot image work.

1. Add architecture-specific CI and build identities without enabling execution.
2. Implement and qualify private filesystem and process identity boundaries.
3. Finish the Windows supervisor, native controller, and writer together.
4. Enable core execution only after the compiled safety inventory passes.
5. Package, exercise installation/update recovery, then qualify both installers.

## Current gaps

`.github/workflows/windows.yml` now defines both native runner jobs. It selects
the matching Bun, Node and MSVC architectures, installs the frozen lock without
application setup, and requires actual supervisor acceptance before the full
controller/writer and compiled inventory. It has no publication authority.
The workflows have not run on Windows yet; current unported contracts are
expected to fail and must be completed before either architecture can qualify.

`scripts/build-native-runtime.mjs` currently requires Darwin ARM64 and seals
Darwin PTY, AST, Claude, and supervisor assets. The Windows builder must select
reviewed inputs by the actual host architecture, emit `.exe` artifacts, and
inventory the Windows supervisor source and policy in its build identity. It
must preserve the controller/writer/configuration graph, input provenance,
source-change detection, and exact asset digests.

`native-process.js` currently refuses a supervised controller outside Darwin.
Keep that refusal until the Windows launcher and its termination receipt are
qualified. The draft `session-execution-windows.c` uses a restricted token,
private desktop, explicit inherited handles, and a kill-on-close Job Object.
Its write restrictions alone do not establish a read boundary. It needs a
complete reviewed read policy before admission can open.

The existing Windows map found POSIX mode checks in runtime-host, harness,
server, Electron, scripts, and UI path presentation. Port security checks through
one shared boundary; do not silently skip `uid`, mode, or `O_NOFOLLOW` checks on
Windows. Presentation paths and security paths have distinct contracts.

## Filesystem authority

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

## Execution and process ownership

The native supervisor starts the child suspended, assigns it to an owned Job
Object, then resumes it. Disable breakaway; contain every descendant and prevent
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

## Packaging and updating

Build unsigned, per-user NSIS installers with Windows app ID
`dev.devryan.desktop` and one fixed installer GUID. Preserve the macOS app ID and
all protocol/package compatibility identities. Public names are exactly
`DevRyan-<version>-win-x64.exe` and `DevRyan-<version>-win-arm64.exe`.
The release asset table in `packages/electron/release-assets.mjs` owns naming.

Windows updating shares verified release discovery, architecture selection,
resumable downloads, SHA-256 verification, disk preflight, and durable intent
with the desktop updater. Installation uses the verified per-user NSIS
installer after the owned runtime has drained. Validate installer identity,
destination ownership, and the installed version before acknowledging success.
Keep the previous installation and intent until an isolated next launch proves
readiness; preserve recovery state on interruption or refusal. Do not claim
Authenticode signing for unsigned installers.

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

The Windows release follows macOS 2.0.2 only after both architecture columns
pass their mandatory gates. Until those results exist, Windows remains a port
in qualification.
