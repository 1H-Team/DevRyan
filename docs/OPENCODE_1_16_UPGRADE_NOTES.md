# OpenCode 1.16 Upgrade Notes

Date: 2026-06-05

## Result

- `@opencode-ai/sdk` is declared as `^1.16.0` in the root, web, UI, package manifests.
- `bun.lock` now resolves `@opencode-ai/sdk` to `1.16.0` with integrity `sha512-S4H2e9j4rdHs5BQOCjmVEdqdXmKwPFKjXPbPUaWiRJpAjBcZ/uIBpoZkmV+x9BLzc+vrE6WAffMZieQgukt4DA==`.
- Web OpenCode runtime policy now target `1.16.0`.
- `/api/config/opencode-resolution` now advertises `targetVersion: "1.16.0"` and install command `curl -fsSL https://opencode.ai/install | bash -s -- --version 1.16.0 --no-modify-path`.
- No DevRyan API endpoint changes were needed.

## SDK Compatibility

- `@opencode-ai/sdk@1.16.0` keeps the same public export map used by DevRyan, including `@opencode-ai/sdk/v2` and `@opencode-ai/sdk/v2/client`.
- Generated v2 SDK types changed in the 1.16 package, including event, permission, question, fs, skill, and session API surfaces.
- DevRyan remains on its existing SDK method usage. Type-check, focused sync tests, and full validation did not require a migration to new `client.v2.*` endpoint shapes.

## Validation

- Focused web resolution test: `bun run --cwd packages/web test -- server/lib/opencode/opencode-resolution-runtime.test.js` passed, 1 test file and 1 test.
- Focused SDK-sensitive UI sync tests passed: event pipeline, reconnect recovery, session actions, message fetch, bootstrap global/session-list, and plan lifecycle detection/settlement suites.
- `bun run validate:affected` passed. It expanded to full validation because dependency and shared validation files changed: lint, workspace type-check, full UI tests, full web tests, full VS Code tests, and quota provider tests all passed.
- `bun run --cwd packages/web test` passed, 70 test files and 524 tests.
- `bun run electron:build` passed after rerunning with approval so electron-builder could write its cache under `~/Library/Caches`. The first sandboxed attempt reached DMG creation and failed only on that cache lock path. The approved run produced the macOS arm64 zip and DMG block maps. Local notarization was skipped because notarization options were unavailable.

## Runtime Smoke

- Installed `opencode-ai@1.16.0` in `/private/tmp/devryan-opencode-116-smoke` using a temp npm cache. The global OpenCode install was not modified.
- Isolated CLI check: `/private/tmp/devryan-opencode-116-smoke/node_modules/.bin/opencode --version` reported `1.16.0`.
- OpenCode `1.16.0` was started on `127.0.0.1:41016` with `--pure --print-logs` and temp `HOME`, `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, and `XDG_STATE_HOME` paths.
- DevRyan web server was started on `127.0.0.1:31016` with `OPENCODE_HOST=http://127.0.0.1:41016`, `OPENCODE_SKIP_START=true`, and `OPENCHAMBER_PORT=31016`.
- DevRyan `GET /health` returned `status: ok`, `openCodePort: 41016`, `openCodeRunning: true`, and `isOpenCodeReady: true`.
- DevRyan `GET /api/config/opencode-resolution` returned `targetVersion: "1.16.0"` and the matching 1.16.0 install command.
- DevRyan `GET /api/session/status` and direct OpenCode `GET /session/status` both returned `{}` before any active run.
- DevRyan `GET /api/global/event` emitted a `server.connected` SSE event.
- Direct OpenCode `POST /session?directory=/private/tmp/devryan-opencode-116-workspace` created a session with `version: "1.16.0"` and title `DevRyan 1.16 smoke`.
- Prompt streaming was not attempted because the isolated temp runtime intentionally had no provider credentials.
- Temporary smoke-test servers were stopped after verification.
