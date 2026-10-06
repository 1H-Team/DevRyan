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
application setup, attempts the controller/writer build even when supervisor
qualification refuses, and requires both before the integrated compiled
inventory. A final gate refuses failed or skipped outcomes. It selects the
architecture-specific MSVC component (including ARM64) and fences Git discovery
above disposable fixtures. It has no publication authority.
The first [native CI run](https://github.com/1H-Team/DevRyan/actions/runs/37349064957)
at `7e328f87690f9b01d0603d302a95a724aae31ef7` compiled both supervisors with
Bun 1.3.14 and the native SDK. Both qualification jobs failed: the token handle
lacked adjustment rights, existing tests use POSIX socket and directory-sync
assumptions, and the controller/writer builder still requires Darwin ARM64.
The token handle now requests `TOKEN_ADJUST_DEFAULT`, required by its existing
integrity/default-DACL changes ([Microsoft token access rights](https://learn.microsoft.com/en-us/windows/win32/secauthz/access-rights-for-access-token-objects)).
It is not inherited by the child. Actual native
execution must be rerun; this correction does not qualify either architecture.
Logs and downloaded artifacts are retained under
`.cache/release-2.0.2-recovery/windows-native-first-run`.
The [token-right rerun](https://github.com/1H-Team/DevRyan/actions/runs/37352574985)
at `9d52371b8917d60c2969d86821bee6ceaa278f70` compiles both architectures and
advances past token adjustment. Both jobs still fail; x64 now reports Job Object
UI boundary error 87. [Nested jobs cannot carry UI limits](https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs).
Complete and verify the isolation policy under a containing host job; do not
remove the boundary merely to make CI pass. The retained rerun log is
`.cache/release-2.0.2-recovery/windows-native-token-right-run.log`.

The isolated Windows implementation adds a read-only `--inspect-process PID`
supervisor operation. It queries creation `FILETIME`, physical liveness and
containing-job membership from one non-inherited Windows process handle,
without changing files, security descriptors or admission. Its separate native
CI check retains stable parent/child identities, actual child exit and invalid
PID refusals in `host-boundary-evidence.json`. This measures the runner's actual
job membership before revising the containment design; it does not qualify
restricted execution or authorize takeover. Shared ownership callers still
remain conservatively fenced pending integration and the full safety inventory.
The native APIs are [GetProcessTimes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes)
and [IsProcessInJob](https://learn.microsoft.com/en-us/windows/win32/api/jobapi/nf-jobapi-isprocessinjob).

The [identity run](https://github.com/1H-Team/DevRyan/actions/runs/37359682512)
at `1aff987701f9c8c45d6e443aa602b260fcc57eb8` passed stable native process
creation/liveness and owned child exit on both architectures. Both actual runners
report containing-job membership. Full safety and controller/writer builds still
fail, and execution remains unavailable. A following change binds the native
supervisor's parent handle to creation before the supervisor, rather than
accepting a numeric parent PID alone.

The SDK boundary also now inspects file identities and private ACLs from the same
no-follow handle and creates private directories exclusively while retaining all
ancestors against write/delete sharing. Existing ACLs are never repaired.
Separate architecture checks cover inherited ACLs despite `chmod(0700)`, Unicode
and case paths, hard-link identities, junction refusal and locked files. These
native checks must pass before shared filesystem owners use that boundary; they
do not replace the confinement inventory. The underlying APIs are
[GetFileInformationByHandleEx](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfileinformationbyhandleex),
[GetSecurityInfo](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-getsecurityinfo)
and [CreateDirectoryW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createdirectoryw).

The [filesystem run](https://github.com/1H-Team/DevRyan/actions/runs/37363627676)
at `6c466e82ae1b063152c28bdfe2bd3d379d24de68` compiled both SDK boundaries and
passed native parent identity on each architecture. Both filesystem receipts
remain failed after their private-directory checks: an ordinary Node-created
file did not satisfy the current-user ownership assertion. GitHub's displayed
step conclusion is not acceptance when `continue-on-error` applies; inspect
the retained receipt and final gate outcomes. The next implementation explicitly
creates private files with current-user ownership and a protected ACL instead of
accepting an inherited/default owner. It bounds input, flushes the file before
identity publication, rejects device/stream aliases, refuses replacements, and
retains an interrupted file for recovery. Fresh native results are required.

The first attempt at `c6840ad04d1592ab16b1b2551f6ac13e2528f25a` was
[unavailable](https://github.com/1H-Team/DevRyan/actions/runs/37366300612):
GitHub cancelled both jobs before acquiring a hosted runner. Neither job ran
any checks or produced native artifacts. The retained annotations are
`.cache/release-2.0.2-recovery/windows-sdk-ci-3-{x64,arm64}-unavailable.json`.
The retry acquired both runners and compiled both SDK artifacts. Each passed
the process/parent identity check and 13 filesystem checks, including private
file ownership, Unicode/case identity, hard links, and junction refusal. Both
then failed the exclusive-file-lock refusal: attribute/security-only handles
can bypass Windows sharing restrictions. The inspection operation now requests
read access as well, so an exclusive lock must refuse the identity. This needs
a fresh native run. The retained receipts are under
`.cache/release-2.0.2-recovery/windows-sdk-ci-3`.
Full confinement and controller/writer builds still fail; execution remains
unavailable. The local workflow contract checks both independent boundary
steps and requires their actual `outcome` in the final gate.

Run `37370143551` at `a8810206` passed all 14 filesystem checks and both
process/parent identity checks on both architectures. Run `37371384474` at
`0a8225ae` also passed the new parent-anchored inspection refusal: 15 filesystem
checks pass on each architecture. Original receipts remain under
`.cache/release-2.0.2-recovery/windows-sdk-ci-{4,5}`. The latter supervisor
SHA-256 values are `a8e55bdba2d6f39dae0114b6deae548bf8275b64f8c9b83fbb72dcf7beb945e4`
(x64) and `74239280e1046628be870b610597a38cf68c5d3f5e9a893c7c30fc7db17b720b`
(ARM64). Neither run qualifies confinement or controller/writer execution.

The pinned libsql 0.5.29 publication has no Windows ARM64 native package.
Its [registry metadata](https://registry.npmjs.org/libsql/0.5.29) records source
commit `55bee86d1c284f1ddf2b9e280e870d2b6cef884a` in `tursodatabase/libsql-js`.
The Windows job now attempts that exact source with its original Cargo lock
(`897f93398893ce805b389b482ddf7555b75365a5f48a2e345703f21c1c58d74e`).
It uses Rust 1.85.1 native host tools, available for both MSVC architectures,
and verifies compiler/binary PE architecture before executing the existing
database API in Node and Bun. The upstream toolchain file remains pinned and
unchanged; the explicit Windows build-tool override adds no application
dependency and updates no lockfile. Source changes and dependency resolution
changes refuse the build. `libsql-source-evidence.json` is an asset candidate
receipt, not runtime acceptance. Native build results are recorded below; the
controller/writer must still seal and qualify the actual reviewed resource.
The Windows AST 0.45.3 and Claude 2.1.251 resources now have independent native
CI qualification. Their original published archive integrity and full binary
digests are pinned separately for x64 and ARM64. The builder extracts only the
selected executable, rejects changed/aliased files, verifies PE architecture,
and executes `--version` with an isolated home/configuration. Original Mac
hydration and the six-family reviewed source closure stay unchanged. Native
results are recorded below; these executable candidates supply no admission grant.
Run `37381203090` built the exact source on x64 and passed the Node and Bun
database checks. ARM64 preserved the same source bytes but failed CMake's
Visual Studio generator discovery. The builder now explicitly uses MSVC's
`NMake Makefiles` generator with the native architecture's `VsDevCmd` tools;
Run `37383981687` at `a92c85e2` then built the unchanged source natively on
both architectures with NMake. Both passed the existing database transaction,
rollback and Unicode checks in Node 22.23.3 and Bun 1.3.14. Independent downloaded
binary inspection confirms the PE architecture and receipt SHA-256:
`3ec054ed07b0e8cc756e77a6a52d06ea10b26611527baa869a60610cc189a8b1`
(x64) and `f9a7564676a8d6b51d0db15628a68d7900783d9b2c424f190ab99365507531de`
(ARM64). Evidence is retained under
`.cache/release-2.0.2-recovery/windows-libsql-ci-4`. These are verified database
asset candidates; both jobs still fail the full safety gate, so neither
architecture has controller/writer or runtime admission acceptance.

Run `37393296975` at `b655752f` executed the pinned AST and Claude versions on
both native architectures and repeated the pinned libsql Node/Bun ABI checks.
Downloaded binary digests, PE identities and all nine required step outcomes
were independently reviewed in `windows-native-ci-6-review.json`. Process and
filesystem identity checks also passed, while supervisor acceptance failed,
the controller/writer build refused its Darwin-only host boundary, and compiled
runtime acceptance did not run. The feature inventory failed while importing
legacy Bot service fixtures with a POSIX default path; an independent original
function reproduction retained `bot_runtime_secret_invalid`. The Windows
construction guard now lives in its own test module so native qualification
does not initialize unsupported POSIX service fixtures. This correction and
the new ARM64 Cursor guard still require a subsequent native CI result.
Run [37395518850](https://github.com/1H-Team/DevRyan/actions/runs/37395518850)
at `6c216d8c` repeated the process/parent checks, all 15 filesystem checks,
pinned AST/Claude version checks, and libsql Node/Bun ABI checks on both actual
architectures. Downloaded receipts, PE identities, pins and binary digests were
independently verified in `windows-native-ci-7-review.json`. The supervisor
source receipt matches the tracked source after Windows checkout CRLF
conversion; both manifests still explicitly record `acceptance: false`.
Both jobs remain failed. The feature inventory stops before runtime construction
because the Cursor fixture's parent directory is absent. The original failure
and a disposable filesystem reproduction are retained; the fixture correction
still requires a native rerun. The x64 supervisor log records UI boundary error
87; the ARM64 log records descendant and inherited-handle failures without that
complete diagnostic. The Darwin-only controller/writer build still refuses both
hosts, and compiled runtime acceptance is skipped. Deleted transient fixtures
provide no durable journal roots. None of these partial passes enables admission.

The isolated branch now creates the Cursor fixture parent before `mkdtemp`.
All three focused Cursor checks pass locally; actual Windows verification is
still required. Integrated local validation attempt 5 passed 660 harness cases
but failed four platform-specific input cases at Bun's default five-second
deadline. All four failures independently reproduced; their unchanged bodies
passed with the file's existing 120-second fixture deadline. Applying that same
deadline to platform-specific registrations passed all 15 input checks and 111
assertions. Original failures and unavailable fixture journals remain recorded.
The next native run also captures an independent empty-job UI-limit probe and
read-only containing-job flags. It never changes the containing job, starts a
child, or permits breakaway; its diagnostic result cannot enable admission.
Run [37399204561](https://github.com/1H-Team/DevRyan/actions/runs/37399204561)
at `79cd2dd9` failed on both architectures. The Cursor fixture and native feature
guards advanced to the UI files, where a terminal mock leaked into the provider
test. The exact original three-file command independently reproduced the
missing `I18nProvider` export. CI now reuses the existing UI test runner, which
isolates files that mock modules. The empty-job diagnostic also stopped before
writing its receipt: both native SDKs emitted `requestedUIFlags: 1023`, whereas
the verifier expected 255. The validator now requires the actual ten-flag SDK
mask and retains UI refusal as a valid diagnostic outcome, without changing the
supervisor policy. The two additional flags and their OS requirements are
documented in [Microsoft's UI policy](https://github.com/microsoft/mxc/blob/main/docs/process-container/os-version-support.md).
Actual native receipts are still required; this change does not qualify
containing-job isolation or runtime admission.

Run [37401394828](https://github.com/1H-Team/DevRyan/actions/runs/37401394828)
at `91bd7494` passed the corrected feature checks, read-only process/job probes,
15 filesystem checks and pinned executable/libsql ABI checks on both hosts.
Supervision acceptance failed, and controller/writer compilation stopped on a
reviewed-input hash mismatch before producing candidates. Independently reviewed
receipts show both containing jobs permit explicit and silent breakaway. The
empty-job UI probe requests `0x3ff`: x64 Server 2022 refuses with error 87;
ARM64 Windows accepts and reads back the exact mask. These diagnostic passes
grant no admission authority.

A disposable `core.autocrlf=true` checkout independently changes the reviewed
Slim JavaScript from 2,452,141 to 2,522,205 bytes. Its converted digest differs
from the manifest; LF normalization reproduces the original digest.
`.gitattributes` now preserves the exact reviewed closure and the reviewed
document/browser source bytes across checkout platforms. A real Git checkout
regression verifies the scoped rules; runtime hash checks remain exact and now
identify the offending public file. The imported Windows build helpers also
participate in macOS native build identities, verified by an actual shared
macOS build. Fresh Windows compilation and full safety acceptance remain required.

Run [37402878771](https://github.com/1H-Team/DevRyan/actions/runs/37402878771)
at `e0ba65b0` advanced past reviewed-input checking on both hosts, then refused
the compaction observation transform before inventory. Its original guard
requires a helper path starting with `/`, which rejects the drive paths supplied
by the Windows build owner. The transform now uses native `path.isAbsolute`
while preserving the exact SDK digest, single insertion anchor and control
character refusals. Focused tests exercise a real native helper path and verify
that removing the observation restores the original bytes. Actual Windows
compilation and the complete native safety inventory remain outstanding.

The supervisor now queries the actual OS build through `RtlGetVersion` and
requests all available UI restrictions: the eight original flags, IME from
build 22621, and injection from build 26100. This follows
[Microsoft's build gates](https://github.com/microsoft/mxc/blob/main/docs/process-container/os-version-support.md).
Unknown OS identity or changed SDK flags refuse; the kernel must accept the
mask and read back every requested bit before a command starts. There is no
retry with reduced restrictions. Protocol-2 diagnostics retain the OS build,
SDK mask and actual mask. Fresh kernel probes are still required, and containing
job isolation, read confinement and full runtime admission remain unqualified.

Run [37403407287](https://github.com/1H-Team/DevRyan/actions/runs/37403407287)
at `22e302ca` compiled both supervisors and retained exact kernel readback:
Server 2022 build 20348 accepts `0xff`; ARM64 build 26200 accepts `0x3ff`.
Both containing jobs still permit explicit and silent breakaway, and supervision
acceptance failed. The controller/writer build reached the compaction helper
path refusal described above. These diagnostic receipts establish the OS mask
selection, without qualifying command confinement or enabling admission.
The native supervision verifier retains an exact supervisor operation/error
number when receipt validation fails; arbitrary worker output is not printed.
The x64 job in run `37404790881` advances through native compilation and then
fails the writer's empty-input boot probe. The subsequent diagnostic build
retains compiled files and source identities, with exit/error fields, output
digests and bounded error summaries. Failed outputs contain no
`native-bundle.json` or accepted launcher and grant no admission.
The original probe deadline and required refusal reply remain unchanged.

Run [37405887286](https://github.com/1H-Team/DevRyan/actions/runs/37405887286)
at `81f39b99` retains both architecture-native controller/writer binaries and
their original source identities. Both controllers return the expected empty
boot refusal; both writers exit 0 without a reply. Independent payload review
finds the exported writer helpers but no protocol handler guarded by
`import.meta.main`. The compiled builder now uses the thin `writer-entry.ts`
to invoke that same owner explicitly. Fifteen routing checks and a fresh macOS
native build, signature/resource verification and both boot refusals pass.
The following native rerun verifies the entry correction on both architectures.

The ARM64 failure receipt was written before an `EPERM` directory rename hid
the boot error. Unqualified Windows builds now create their private output
exclusively, write `native-candidate.json` last with exclusive creation only
after all checks pass, and retain failed files in place. They never replace an
existing output, produce a production bundle, or grant admission.

Run [37408333818](https://github.com/1H-Team/DevRyan/actions/runs/37408333818)
at `725c354d` compiles both controller/writer pairs and passes both exact
empty-input boot refusals on x64 and ARM64. Independent downloaded-artifact
review verifies PE architecture, all payload and source hashes, original
dependency pins, the reviewed libsql source/ABI receipts and all nine actual
step outcomes. Both receipts remain explicitly unqualified with
`admission: false`; no production manifest or accepted launcher is emitted.
Supervision still fails on both hosts. x64 retains the confined Node
`0xc0000142` initialization failure; ARM64 reaches descendant, inherited-handle,
Unix-socket, permission-mode and Revert durability failures. The compiled
runtime inventory is skipped. Build and boot success do not establish the
read boundary, descendant containment or initialized runtime acceptance.

Command supervision remains failed. The x64 confined Node command returns
`0xc0000142`; this is separate from the writer's compiled entry failure.
[Microsoft's process contract](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessasuserw)
requires access to both the selected window station and desktop, and its
[initialization guidance](https://learn.microsoft.com/en-us/troubleshoot/windows/win32/user32-kernel32-not-initialize)
identifies missing access as a possible DLL initialization failure. Review a
private UI-object owner and prove standard-user behavior before changing this
boundary; do not alter the user's window-station ACL or enable admission.

The separate startup diagnostic now compiles four disposable source copies:
original, no UI job limits, an exclusive private window station, and their
combination. Each runs a trusted stdout-only probe with the actual Node and
pinned Bun executable. Source/binary/output digests and empty, partial or
complete termination receipts remain evidence; no copy receives an acceptance
marker, enters a runtime bundle, or satisfies a required Windows gate.
The station probe restores the inherited station and changes no inherited ACL.
Actual native results and standard-user/concurrent station ownership remain
unqualified. Its API owners are
[CreateWindowStationW](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-createwindowstationw)
and [SetProcessWindowStation](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setprocesswindowstation).

The x64 startup probes in run
[37414619426](https://github.com/1H-Team/DevRyan/actions/runs/37414619426)
reproduce all four variants with verified source, PE, binary/output hashes and
durable receipt bytes. Node remains at `0xc0000142`; Bun remains at
`0xc06d007e`. Neither a private station nor absent UI restrictions resolves
startup. A fifth disposable variant changes only the token integrity SID from
Untrusted to Low, retaining the original job, handle and write restrictions.
It tests another startup condition, supplies no policy acceptance, and never
changes the production supervisor. Both actual architectures must still run it.

The ARM64 receipts from the same run independently verify original and
UI-limit-only Node/Bun startup. Both exclusive unnamed station variants refuse
with Windows error 183 and empty termination receipts. Reusing an existing
station or modifying the inherited station ACL is not an authorized fallback.

A sixth disposable probe adds SYSTEM access only to the token's default DACL
for newly created child objects. The file-tree ACLs, integrity level, job,
inherited handles and parent-death contract stay unchanged. It isolates another
startup condition because [CreateProcessAsUserW](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessasuserw)
uses that token's default process/thread security when explicit descriptors are
absent. It supplies no process-security qualification and leaves the production
supervisor unchanged; actual native results are required before drawing a
causal conclusion.

Run [37417726695](https://github.com/1H-Team/DevRyan/actions/runs/37417726695)
retains 24 independently reviewed startup probes. The process-DACL variant
leaves x64 Node/Bun failures unchanged. ARM64 starts that variant and the
original, no-UI and Low variants; Bun retains ancestor configuration access
diagnostics. The private-station variants refuse at window-station creation
with error 183. Both required supervisor acceptance gates still fail and
runtime acceptance remains skipped.

A seventh disposable probe adds SYSTEM access only to the newly created
desktop's descriptor. Its Untrusted integrity label, file-tree ACLs, token
default DACL, full job restrictions and inherited handle boundary remain
unchanged. [CreateDesktopW](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-createdesktopw)
accepts a separate descriptor for that object; this probe isolates it without
changing the inherited station. It supplies no desktop-security qualification
and changes no production helper. Native evidence must precede any root fix.

Integrated local `validate:full` passes on macOS ARM64 at `874ab3f4`, including
6,328 web tests, 4,049 UI tests and 39 retained legacy Rust tests. Earlier failed
attempts are preserved. Only builder-generated legacy defaults were restored
to their frozen source bytes; the missing ignored web/sidecar fixtures were
prepared without changing those defaults. The successful log digest is
`9e90adb2a0e44ddbfc25ce7629ea08f4ae21627e5eef730dd25eee2889500b48`.
This local pass does not qualify native Windows execution or the final release.

The [Rust platform contract](https://doc.rust-lang.org/stable/rustc/platform-support/windows-msvc.html)
supports native MSVC ARM64 host tools; that support does not establish libsql
compatibility by itself.

The initial source attempt in run `37377148453` failed before compilation on
both architectures. The x64 stage receipt from `37380055984` independently
identified checkout line-ending conversion: its `Cargo.toml` digest
`1095aa076118ca6e5da4379c23a1cfc40dde4201c55beb3896412a5f1e0762c4`
exactly matches the official pinned bytes converted to CRLF. The source
checkout now overrides `core.autocrlf=false` for that step alone. A disposable
actual Git checkout reproduces conversion and verifies the override preserves
the original bytes with a clean index. The original Cargo/source hash gates
remain exact; a native build and ABI pass are still required.

`scripts/build-native-runtime.mjs` currently requires Darwin ARM64 and seals
Darwin PTY, AST, Claude, and supervisor assets. The Windows builder must select
reviewed inputs by the actual host architecture, emit `.exe` artifacts, and
inventory the Windows supervisor source and policy in its build identity. It
must preserve the controller/writer/configuration graph, input provenance,
source-change detection, and exact asset digests.

The isolated implementation now adds a Windows-only `--windows-candidate`
mode. It selects the existing verified AST/Claude inputs and source-built
libsql receipt, preserves the original six-family closure and graph inventory,
and emits architecture-native `.exe` controller/writer candidates. The original
Meridian resolver accepts only the selected target; the persistent PTY resolver
refuses before environment or filesystem access. Native PE inspection and both
empty-input boot refusals precede an immutable `native-candidate.json` receipt
with `admission: false`. It emits no production manifest or accepted launcher
and cannot be packaged as an accepted runtime. The original native PE builds
are retained, including the failed earlier probes; the explicit entry
correction passes both native reruns. Initialized controller/writer behavior, held file
authority, read confinement and the integrated acceptance inventory remain
unqualified; the ordinary production builder continues to refuse Windows.

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
