# Release speed and repository organization — 2026-09-07

All six implementation stages are present. The earlier maintenance-audit changes
were preserved. No release, npm package, image, database change or deployment was
published during verification.

## Review sequence

| Stage | Implemented behavior |
| --- | --- |
| 1. Commands | Explicit web/main compilation, native preparation, mandatory manifest-gated packaging, compatibility aliases |
| 2. Images | Six image jobs, three concurrent, persistent per-image caches, isolated signing results, strict complete-manifest aggregation |
| 3. Web artifact | One producer; commit/version/lock/options/file checksums; complete hidden/static files; shared npm/Electron consumers |
| 4. Desktop overlap | Native preparation starts alongside images; architecture-bound tar handoffs; packaging waits for all verified inputs |
| 5. Dependencies | Explicit UI/test/build consumers, root cleanup, workspace-relative SDK/native resolution, installable npm workspace closure |
| 6. Entrypoints | Settings/window/host persistence, menus and notifications extracted from Electron; skill discovery and compression policy extracted from server |

Operational commands and ownership are documented in [Release pipeline](../../RELEASE_PIPELINE.md).
[Dependency ownership](dependency-ownership.json) records removals and retained
exceptions. Existing resolved dependency versions, patches and container lockfiles
were preserved; lockfile layout changes include deduplication rather than upgrades.

## Confirmed packaging correction

The original npm tarball failed a fresh consumer installation with
`EUNSUPPORTEDPROTOCOL: workspace:*`. The packaging helper now bundles all five
private runtime packages under their existing names and versions, resolves their
workspace references, and preserves external dependency ranges. npm publishes the
same tarball that passed artifact verification.

The corrected tarball installed in a separate consumer project, native dependency rebuilds completed, and the installed CLI help command succeeded. All five bundled
runtime entrypoints loaded from that installation. Default-config integrity and
the 16-plugin packaged orchestration smoke passed. Every npm web output checksum
matched the shared artifact and Electron's staged web tree.

## Verification

- Full validation passed, including 309 Electron tests and 3,720 web tests across
  361 web suites, plus the repository, UI and remaining workspace gates.
- Root build and bundle budgets passed. A fresh source copy installed the frozen
  lockfile and built successfully; the existing terminal patch applied.
- Artifact tests passed for incomplete/duplicate/stale image results, signing
  failure, missing/corrupt web files, native architecture/identity mismatch and
  packaging failure ordering. Final focused image checks also passed after
  preserving the existing filesystem-injection contract.
- ARM and Intel native preparation passed in the isolated copy. Both native
  archives exported and imported successfully. The inspected ARM archive retained
  4,990 relative symlinks and executable mode `0755` on the runtime-service bridge.
- Isolated web and Electron chat QA passed, including streaming, typing, sending,
  cancellation, reconnect and duplicate prevention. The first Electron QA attempt
  exposed a missing focus callback after extraction; that wiring was corrected
  and the journey passed on rerun.
- A timing-sensitive existing bootstrap test failed under concurrent install
  load, passed in isolation, and passed in the final full gate. Its assertions
  were not weakened.
- Documentation validation and whitespace checks passed.

[Machine-readable verification](verification.json) records local log digests.
[ARM preparation](arm64-preparation.json) and [Intel preparation](x64-preparation.json)
record architecture-bound archive identities. Large temporary install/archive
fixtures are removed after verification; logs remain under ignored
`.cache/release-organization/`.

## Release-only acceptance remaining

Actual GitHub cache reuse, image publication/signing, production Docker topology
smoke and end-to-end release duration were not exercised locally. They remain
mandatory workflow gates. The known release baseline is 20m08s, with five recent
runs in the 20–24 minute range; a 30% warm-cache improvement remains a target.
The local prepared archives are approximately 400 MB each, so CI timing should
include handoff upload/download cost.

The available published Bot manifest belongs to revision
`7dbca20beaeac9cf71ea4f2cf9f8d51ae696c8e5`; this working source starts at
`76c7cbfb3721610e5760a98e6795724f3334c6c4`. Production packaging correctly rejected
that mismatch before invoking the builder. Consequently complete DMG/ZIP,
runtime-service and updater package acceptance against the new pipeline requires
a matching manifest from an authorized release run. No verification bypass or
development manifest was substituted.
