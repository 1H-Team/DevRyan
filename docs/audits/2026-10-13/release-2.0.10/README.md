# DevRyan v2.0.10 release record

v2.0.10 contains the [startup lockout fixes](../startup-unsettled-lease/README.md).
It was published on 2026-10-13 from source
`aa5da4d80c86f6a1a1c9a6e992c40114043ef039`, tag `v2.0.10`.

## Local verification

`bun run validate:full`, `bun run build`, `bun run docs:validate` and
`bun run bundle:check` passed on the release commit.

## Release workflow

[Workflow 38398896489](https://github.com/1H-Team/DevRyan/actions/runs/38398896489)
created the draft, verified and published the signed Bot images, passed the
topology smoke, and packaged and uploaded the DMG in about ten minutes. Its
final-DMG startup qualification then ran for 39 minutes and failed, so the
workflow's own finalize job was skipped.

The [qualification summary](qualification-summary.json) records that run:

- All 52 compiled native cases passed.
- Nine GUI scenarios passed: empty profile, unchanged reopen, upgrades from the
  two previous releases, same-runtime upgrade, unsettled-process recovery,
  interrupted upgrade, rejected candidate and stale owner.
- `service-warm` failed after 190 seconds with `Read-only probe deadline
  expired`. `service-cold` depends on it and did not run.

The cause of the `service-warm` failure was not established. The app had
started and its runtime-service owner process was alive when the probe expired.
Because 2.0.9 never reached the service scenarios, it is unknown whether the
failure is new in 2.0.10.

## Owner waiver and publication

The release owner explicitly waived the failed GUI qualification gate for this
release. The failed receipt stays failed; nothing is relabeled as passed.

Before publication the draft was checked by hand:

- `scripts/verify-release-assets.mjs` confirmed the draft held exactly
  `DevRyan-2.0.10-arm64.dmg`, 390569377 bytes, SHA-256
  `fcc9ecf63e0e73afad2d73363ee1dd1a5e081a922525f89e9e5668e7d920348a`, matching
  the packaging digest and the qualification receipt.
- The tag and the build source were both the commit above.
- No Supabase migration or production schema-marker source changed between
  `v2.0.9` and `v2.0.10`, so the skipped migration deploy had nothing to apply.

The draft was then published with `gh release edit v2.0.10 --draft=false
--latest`. No artifact was rebuilt.

## Not verified

- The background runtime-service startup scenarios (`service-warm`,
  `service-cold`).
- Restart recovery after an actual OS reboot, and Windows qualification.
- The hosted migration deploy and verification step did not run for this
  release.

## Workflow change after this release

The startup qualification job and its receipt check were removed from
`release.yml`. It remains a manual QA check and no longer gates publication.
