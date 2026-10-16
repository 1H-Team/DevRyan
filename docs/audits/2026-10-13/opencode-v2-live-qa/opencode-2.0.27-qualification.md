# OpenCode 2.0.27 qualification prerequisite check

Checked 14 October 2026. **Blocked before candidate build; no runtime, upgrade, rollback or performance qualification pass.** The shipped 2.0.26 pins, manifests, lockfile and reviewed transformations remain unchanged.

## Official package source inspection

Read the official npm registry metadata for `@opencode/{core,schema,ai,plugin,sdk,util,simulation}@2.0.27`. All seven require `effect: 4.0.1`; this repository pins `4.0.0-rc.112`. This requires constructor/Layer/API review and an isolated dependency closure; package availability does not establish compatibility. Sources: [core metadata](https://registry.npmjs.org/@opencode%2fcore/2.0.27), [schema metadata](https://registry.npmjs.org/@opencode%2fschema/2.0.27), [SDK metadata](https://registry.npmjs.org/@opencode%2fsdk/2.0.27).

Fetched only the official core and schema tarballs into memory, verified their registry SHA-512 integrity, and inspected entry bytes without extraction, installation or execution of package code. No downloaded payload remains on disk.

| Existing prerequisite | Candidate observation | Result |
| --- | --- | --- |
| `rewriteNativeAgentDefaults` exact `schema/dist/agent.js` source | Candidate SHA-256 `77b986c1ef47ac2417157b6bd93881bf73655476765f9c43c560c81aac7731a0`; reviewed SHA-256 `0327d7211fb85ccbf4aa9de4b134ba2928872b8529548fa7efefa07222748023` | Actual existing transform threw `Pinned native agent defaults changed` |
| Compaction observation entry `core/dist/chunks/location-services-qhaz1dgr.js` | Entry absent from integrity-verified 2.0.27 core archive | Existing builder cannot read its pinned transform input |
| Reviewed cross-release native clone pair | Finite release graph map includes 2.0.20, 2.0.24 and 2.0.26, excludes 2.0.27 | Existing guard refused `bundle_v2_upgrade_compatibility_required`, status 503 |

The guard check used declared candidate metadata, not a built candidate manifest or fabricated candidate digest. Its negative result proves rejection by the current owner only; it does not test a 2.0.27 database.

## Existing runner limits

- `scripts/build-native-runtime.mjs` resolves repository workspace dependencies, requires Bun 1.3.14, and stamps `opencodeVersion: '2.0.26'`. Its output-root option isolates output, not input dependencies. It has no candidate package-root/version input.
- `scripts/opencode-v2-native/artifacts.mjs` asserts every native OpenCode package is 2.0.26 and checks the repository Effect pin. Redirecting packages or relabelling a manifest would bypass acceptance.
- `scripts/verify-opencode-v2-package.mjs` qualifies already-built verified artifacts; it does not provision an independent runtime package closure.
- `scripts/perf/runtime-upgrade-comparison.mjs` compares already-collected exact-source reports; it cannot build or qualify a missing candidate. Performance is separate from clone compatibility and confinement.

## Required review before execution

An explicitly reviewed isolated package-input profile must resolve the complete official 2.0.27 closure, including Effect 4.0.1, without changing or shadowing shipped workspace dependencies. Review the changed agent defaults and new compaction source/anchors before authorizing any additional exact transformation. Review constructor, provider, credentials, confinement, stop/settlement and clone schema/migration contracts; a new version/digest allowlist entry needs actual original-controller evidence. Then build a truthfully identified candidate through the existing owners, run the full compiled package gate, collect exact-source upgrade/rollback evidence against a frozen baseline, and collect performance reports separately. No pins or guards were relaxed in this check.

## Verification retained

```text
./node_modules/.bin/vitest run server/lib/opencode/runtime-host/native-setup-seed.test.js server/lib/opencode/runtime-host/native-bundle-compatibility.test.js --no-file-parallelism --maxWorkers=1
Test Files: 2 passed; Tests: 47 passed
```

Executed from `packages/web` using the repository-installed runner. The suite includes rejection of 2.0.27 in both clone directions. Passing these existing guard tests is not a candidate qualification pass. The seed regression separately confirms helper selection/revision survives fresh setup, retains primary/notification preferences, excludes conversation authority, and reuses the original pinned seed.
