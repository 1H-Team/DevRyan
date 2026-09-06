# OpenCode 1.15 Upgrade Notes

Date: 2026-05-15

## Result

- `@opencode-ai/sdk` now resolves to `1.15.0` in `bun.lock`.
- Package manifests already declared `@opencode-ai/sdk` as `^1.15.0`; no manifest pin was needed.
- No SDK/event compatibility code changes were needed after the lockfile refresh.
- `packages/ui/src/components/ui/AnimatedCounter.tsx` now honors `animate={false}` by rendering the static label. This fixed a pre-existing lint failure where the public `animate` prop was declared but unused.

## Validation

- Pre-upgrade focused event suite: 60 passed, 0 failed.
- Pre-upgrade `bun run validate:affected`: passed after fixing the `AnimatedCounter` lint issue.
- Post-upgrade focused event suite: 60 passed, 0 failed.
- `bun run validate:full`: passed.
- `bun run build`: passed.
- `bun run --cwd packages/web test`: 44 test files passed, 271 tests passed.
- `bun run electron:build`: passed and produced macOS arm64 artifacts. Notarization was skipped because notarization options were unavailable in the local environment.

## Runtime Smoke

- Local system `opencode` at `/opt/homebrew/bin/opencode` was upgraded from npm global package `opencode-ai@1.14.39` to `opencode-ai@1.15.0`.
- `opencode --version` now reports `1.15.0`.
- Runtime smoke used ephemeral `opencode-ai@1.15.0` before the global CLI was upgraded; it reported version `1.15.0`.
- OpenCode `1.15.0` was started on `127.0.0.1:41015` with `--pure`.
- DevRyan web server was started on `127.0.0.1:31015` with `OPENCODE_HOST=http://127.0.0.1:41015` and `OPENCODE_SKIP_START=true`.
- `GET /health` reported `status: ok`, `openCodePort: 41015`, `openCodeRunning: true`, and `isOpenCodeReady: true`.
- `GET /api/session/status` and direct OpenCode `GET /session/status` both returned `{}`.
- `GET /api/global/event` returned HTTP 200 with `content-type: text/event-stream`.
- Temporary smoke-test servers were stopped after verification.
