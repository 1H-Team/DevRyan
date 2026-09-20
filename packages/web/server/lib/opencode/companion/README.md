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
It stages `1.18.31-devryan.2` and its native supervisor under
`packages/web/runtime/<platform>-<arch>`. Acceptance includes real OpenCode
execution, Context Mode, a command held across Revert, native descendants,
active target cancellation and Cursor publication. No live provider credentials
or installed-app state are used. Failed acceptance cannot enable the feature.

See [Concurrent Revert](../../../../../../docs/CONCURRENT_REVERT.md) for ownership,
provisioning, recovery, compatibility limits and web/Electron verification.
