# OpenCode 1.17.14 Upgrade Notes

Date: 2026-07-07

## Result

- `@opencode-ai/sdk` is declared as `^1.17.14` in the root, web, UI, package manifests.
- `bun.lock` now resolves `@opencode-ai/sdk` to `1.17.14` with integrity `sha512-ycSYSF0kuJmNUP38VYnsFEoUWPyjlLjAZFPtYuMt+32Tz+NqVsAPcqK3MPBRd5v+GChjAyApB/y56i7Ub08IAg==`.
- Web OpenCode runtime policy now target `1.17.14`.
- `/api/config/opencode-resolution` now advertises `targetVersion: "1.17.14"` and install command `curl -fsSL https://opencode.ai/install | bash -s -- --version 1.17.14 --no-modify-path`.
- No DevRyan API endpoint changes were needed.

## Package Metadata

- `@opencode-ai/sdk@1.17.14` is published with dependency `cross-spawn@7.0.6`.
- The SDK export map is unchanged for the DevRyan imports, including `@opencode-ai/sdk/v2`, `@opencode-ai/sdk/v2/client`, and related v2 exports.
- `opencode-ai@1.17.14` is published with binary `opencode: bin/opencode.exe` and integrity `sha512-UuWFOBtiYufHsvHtnn2/AASjDM8wW+kSkDnvAG2cbfSsIXU3wGG9nS9XSKvLelvZBigTi5DkqFl8Z0YKxMDifg==`.

## Validation

- Focused web resolution test passed:
  - `bun run --cwd packages/web test -- server/lib/opencode/opencode-resolution-runtime.test.js`
  - 1 test file and 1 test passed.
- Focused VS Code bridge runtime tests passed:
  - 9 Vitest files and 41 tests passed, plus 4 quota provider tests.
- `bun run validate:affected` passed. It expanded to full validation because dependency, lockfile, and existing changed files were present: lint, workspace type-check, script tests, UI tests, web tests, VS Code tests, and quota provider tests all passed.
- `bun run build` passed. It emitted existing Vite/esbuild warnings for dynamic import/static import overlap, large chunks, ONNX eval, and Cursor SDK `import.meta` in CJS output.

## Runtime Smoke

- Installed `opencode-ai@1.17.14` in `/tmp/devryan-opencode-11714-smoke.19I1pZ`, without modifying the global OpenCode install.
- Isolated CLI check: `/tmp/devryan-opencode-11714-smoke.19I1pZ/host/node_modules/.bin/opencode --version` reported `1.17.14`.
- OpenCode `1.17.14` was started on `127.0.0.1:41114` with `--pure --print-logs` and isolated `HOME`, `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, and `XDG_STATE_HOME`.
- DevRyan web was started on `127.0.0.1:31114` with `OPENCODE_HOST=http://127.0.0.1:41114`, `OPENCODE_SKIP_START=true`, and `OPENCHAMBER_PORT=31114`.
- DevRyan `GET /health` returned `status: ok`, `openCodePort: 41114`, `openCodeRunning: true`, and `isOpenCodeReady: true`.
- DevRyan `GET /api/config/opencode-resolution` returned `targetVersion: "1.17.14"` and the matching 1.17.14 install command.
- DevRyan `GET /api/session/status` returned `{}` before any active run.
- DevRyan `GET /api/global/event` emitted a `server.connected` SSE event.
- Direct OpenCode `POST /session?directory=/tmp/devryan-opencode-11714-smoke.19I1pZ/workspace` created session `ses_0c4186d68ffenXdSZoMzDTLevc` with `version: "1.17.14"` and title `DevRyan 1.17.14 smoke`.
- Prompt streaming was not attempted because the isolated temporary runtime intentionally had no provider credentials.
- Temporary smoke-test servers were stopped after verification.
