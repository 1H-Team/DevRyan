# DevRyan OpenCode companion

`manifest.json` pins OpenCode 1.18.31, the complete patch digest and every changed
file. The patch includes legacy `files: false` rollback, durable no-file markers,
execution capture, prompt admission, confined native/custom tools, descendant
identities, external Cursor message persistence, generated clients and tests.
The V2 message store is not substituted for legacy histories.

Build and verify with `bun run build:revert-runtime`. To use an explicitly
authorized prepared checkout, run:

```sh
node scripts/build-revert-runtime.mjs --source /absolute/path/to/opencode
```

The builder never resets an existing checkout and refuses unreviewed changes.
It stages DevRyan companion `2.0.0` (reporting plain OpenCode `1.18.31`; its
identity is `companionVersion` in `companion.json`) and its native supervisor under
`packages/web/runtime/<platform>-<arch>`. Acceptance includes real OpenCode
execution, a command held across Revert, native and managed descendants,
active target cancellation and Cursor publication. No live provider credentials
or installed-app state are used. Failed acceptance cannot enable the feature.

A weekly `companion-upstream.yml` job, also runnable as
`node scripts/companion-upstream-check.mjs [--release vX.Y.Z]`, reports whether
the patch still applies to the latest OpenCode release. A rebuild is needed only
when a release is newer than the pinned base. A clean apply means updating the
reviewed base and digests, then rebuilding. A conflict lists the files to rebase.

[SEAMS.md](SEAMS.md) records the per-tool execution audits behind which built-ins
run natively and how workers boot.

See [Concurrent Revert](../../../../../../docs/CONCURRENT_REVERT.md) for ownership,
provisioning, recovery, compatibility limits and web/Electron verification.
