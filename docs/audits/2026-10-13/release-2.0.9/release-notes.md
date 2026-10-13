DevRyan v2.0.9 for macOS Apple silicon.

- Publish runtime ownership locks atomically and wait through temporary ownership contention during startup.
- Make background Bots an explicit opt-in, preserve existing service installations, and safely remove stray registrations before app-bound startup.
- Preserve abandoned-process recovery evidence and reuse the early startup splash without a redundant reload.

The published DMG is the exact artifact from [build 38368339944](https://github.com/1H-Team/DevRyan/actions/runs/38368339944), source `88cf8599c3ce567100749dca4f2658f33db2f10e`.

All 52 compiled checks and six GUI scenarios passed, including upgrades from v2.0.7 and v2.0.8. The release owner explicitly waived the remaining GUI publication gate after a published v2.0.8 baseline cleanup defect stopped the diagnostic run. The incomplete checks are retained as incomplete. Signed Bot image verification, the exact DMG digest and migration parity checks are preserved. Actual reboot recovery and Windows qualification are unverified.

SHA-256: `2cb0a55e3b89e87fc6dcf2b228c3cd874ae5b99b2cf3675e2c92d139bbb26760`

[Release evidence and waiver](https://github.com/1H-Team/DevRyan/blob/main/docs/audits/2026-10-13/release-2.0.9/README.md)
