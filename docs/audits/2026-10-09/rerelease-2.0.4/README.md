# DevRyan v2.0.4 replacement qualification

The user requested removal of the original v2.0.4 release and release commit,
then one replacement commit named `release v2.0.4` containing all current
changes, with a freshly built release named `DevRyanv2.0.4`. The old release
commit and its documentation successor are combined with the pending changes
on the prior main parent; existing implementation is preserved.

The candidate includes the [storage changes](../opencode-storage-v2/README.md)
and [startup upgrade and database clone qualification](../startup-bundle-upgrade/README.md).
The latter records 52 passing compiled-package cases, including legacy and
fresh-install 2.0.20 → 2.0.26 clones, rollback, parent-death cleanup and three
durable journal roots. Those native cases were not repeated for this release
operation.

[Local checks](local-checks.json) passed full workspace lint, types, docs and
deterministic tests, production web/Electron build, bundle budgets and native
artifact verification. UI: 4,067 tests in 589 files. Web: 6,545 tests in 535
files, followed by 14 native-host tests.

[Electron QA](qa-electron.json) passed all seven functional checks, with no
console errors, cleanup failures or archived journal gaps. The
[first attempt](qa-electron-first-attempt.json) reached readiness but timed out
waiting for a session row; it is retained as a failure receipt. Its superseded
private run directory was removed after preserving this receipt.
[Web QA](qa-web.json) passed all seven functional checks and had no cleanup
failures or journal gaps, but failed its overall console gate on bootstrap
403s, as the original release did. That failure was not suppressed.

No Supabase migration files are pending in the checkout. Hosted migration
application and schema verification use the existing GitHub workflow on the
replacement commit before the release tag is recreated. The release workflow
rechecks migration history and the schema marker before publication.

Publication requires freshly packaged `DevRyan-2.0.4-arm64.dmg`, its exact
asset allowlist and packaging digest, signed Bot image verification, anonymous
image access, isolated topology and native packaging checks. The final source
is the recreated `v2.0.4` tag. Historical receipts in
[the original release audit](../release-2.0.4/README.md) qualify only the removed
publication.

Live providers, installed-app updates, Windows and notarization were not
checked. macOS retains the existing ad-hoc signing class. An installation
already reporting 2.0.4 needs the replacement DMG installed manually because
the release version is unchanged.
