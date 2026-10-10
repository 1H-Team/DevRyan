# DevRyanv2.0.5 release qualification

The user authorized replacing the v2.0.5 release, tag and tip release commit,
preserving its changes and including all current changes in one commit named
`release v2.0.5`. The release title is `DevRyanv2.0.5`.

This candidate adds the [provider usage and model repairs](../usage-models/README.md)
to the [previous candidate](../rerelease-2.0.5/README.md).
The local checks are recorded in [local-checks.json](local-checks.json).
The earlier release receipts remain historical and do not qualify this source.

The distribution scope is `desktop-macos-arm64`: exactly one public asset,
`DevRyan-2.0.5-arm64.dmg`. The production workflow verifies signed Bot images,
anonymous pulls, isolated topology, native preparation, packaged runtime,
and the exact asset name, size and packaging digest. It applies pending hosted
migrations and verifies migration history and the schema marker before publication.
No migration source is changed by this candidate.

The publication passed in [run 38050592027](https://github.com/1H-Team/DevRyan/actions/runs/38050592027).
The [publication receipt](release-verification.json) confirms the exact title,
latest non-draft release, source and single-asset allowlist. The published DMG
matches the [packaging receipt](macos-arm64-asset.json) in size and SHA-256.
Both migration dry run and push reported that the hosted database is up to date;
migration history and schema-marker verification passed. The release tag stays
frozen at `fae808f1b0ae6b7f2f93768afaf7727f3bbbc807`; this receipt is
recorded afterwards in a documentation-only commit.
Real-account provider usage and the new provider UI states remain unverified.
Installed-app replacement, notarization and Windows acceptance were not run.
Existing v2.0.5 installations may need manual installation of the replacement DMG.
