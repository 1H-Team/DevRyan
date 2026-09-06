# OpenCode 1.16.2 Upgrade Notes

Date: 2026-06-05

## Result

- `@opencode-ai/sdk` is declared as `^1.16.2` in the root, web, UI, package manifests.
- `bun.lock` now resolves `@opencode-ai/sdk` to `1.16.2` with integrity `sha512-Z/xZ7q79dYeE0afqIk/yFEcRNGEQFcE+H8ssYivUiy+xGZ1mGwT72jpaQZKBwPn3JH4sRCu4KA2lcktBQfcOjg==`.
- Web OpenCode runtime policy now target `1.16.2`.
- `/api/config/opencode-resolution` now advertises `targetVersion: "1.16.2"` and install command `curl -fsSL https://opencode.ai/install | bash -s -- --version 1.16.2 --no-modify-path`.
- No DevRyan API endpoint changes were needed.

## Package Metadata

- `@opencode-ai/sdk@1.16.2` is published with dependency `cross-spawn@7.0.6`.
- The SDK export map is unchanged for the DevRyan imports: `@opencode-ai/sdk/v2`, `@opencode-ai/sdk/v2/client`, and related v2 exports remain present.
- `opencode-ai@1.16.2` is published with binary `opencode: bin/opencode.exe` and integrity `sha512-70w3KxB0tKEA0Fy66McSXY3v5qv3AOX76PXdc0WxQBzEzizCpJtNBp3frMd5VJ+ASwrSe4DxmY3Ve/OByzriMw==`.

## Validation

- TDD red checks failed correctly while policy still returned `1.16.0`:
  - `bun run --cwd packages/web test -- server/lib/opencode/opencode-resolution-runtime.test.js`
- Focused web resolution test passed after the policy update: 1 test file and 1 test.
- Focused VS Code bridge runtime tests passed after the policy update: 5 test files and 21 tests, plus 4 quota provider tests.
- Focused SDK-sensitive UI sync tests passed: event pipeline, reconnect recovery, session actions, message fetch, bootstrap global/session-list, and plan lifecycle detection/settlement suites.
- `bun run validate:affected` passed. It expanded to full validation because dependency and shared validation files changed: lint, workspace type-check, full UI tests, full web tests, full VS Code tests, and quota provider tests all passed.
- `bun run build` passed. It emitted existing Vite/esbuild warnings for bundle size, dynamic import/static import overlap, ONNX eval, and Cursor SDK `import.meta` in CJS output.
- `bun run electron:build` passed with approved access to electron-builder cache paths under `~/Library/Caches`. It produced the macOS arm64 zip and DMG block maps. Local notarization was skipped because notarization options were unavailable.

## Runtime Smoke

- Installed `opencode-ai@1.16.2` in `/private/tmp/devryan-opencode-1162-smoke` using a temp npm cache. The global OpenCode install was not modified.
- Isolated CLI check: `/private/tmp/devryan-opencode-1162-smoke/node_modules/.bin/opencode --version` reported `1.16.2`.
- OpenCode `1.16.2` was started on `127.0.0.1:41018` with `--pure --print-logs` and temp `HOME`, `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, and `XDG_STATE_HOME` paths.
- DevRyan web server was started on `127.0.0.1:31018` with `OPENCODE_HOST=http://127.0.0.1:41018`, `OPENCODE_SKIP_START=true`, and `OPENCHAMBER_PORT=31018`.
- DevRyan `GET /health` returned `status: ok`, `openCodePort: 41018`, `openCodeRunning: true`, and `isOpenCodeReady: true`.
- DevRyan `GET /api/config/opencode-resolution` returned `targetVersion: "1.16.2"` and the matching 1.16.2 install command.
- DevRyan `GET /api/session/status` and direct OpenCode `GET /session/status` both returned `{}` before any active run.
- DevRyan `GET /api/global/event` emitted a `server.connected` SSE event.
- Direct OpenCode `POST /session?directory=/private/tmp/devryan-opencode-1162-workspace` created a session with `version: "1.16.2"` and title `DevRyan 1.16.2 smoke`.
- Prompt streaming was not attempted because the isolated temp runtime intentionally had no provider credentials.
- Temporary smoke-test servers were stopped after verification.
