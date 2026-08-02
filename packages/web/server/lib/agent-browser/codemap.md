# packages/web/server/lib/agent-browser/

## Responsibility

Managed installation and skill provisioning for the Electron-only `agent-browser` runtime used by `devryan_browser`.

## Design

- `install.js` pins `agent-browser` exactly to `0.33.2` under `<OPENCHAMBER_DATA_DIR>/tools/agent-browser`, atomically owns an empty `devryan-agent-browser.json`, runs a bounded `bun install --ignore-scripts`, and validates the package version, current native platform binary, executable bit, and bounded `--version` probe.
- Bun is always spawned through a validated absolute executable resolved from an injected path, `DEVRYAN_BUN_EXECUTABLE`/`BUN_EXECUTABLE`/`BUN_INSTALL`, a Bun-hosted current executable, `~/.bun/bin/bun`, or an absolute `PATH` entry. Finder-launched Electron therefore does not rely on a literal `bun` lookup; unavailable installs return an actionable `bun-unavailable` status.
- Install, ensure, and repair mutations are single-flight and return structured nonfatal status. A failed browser tool install never prevents OpenCode itself from starting.
- Native entrypoint resolution covers macOS and glibc/musl Linux on x64/arm64, plus Windows x64 (the 0.33.2 package has no Windows arm64 binary); unsupported platforms and missing/non-executable binaries are explicit issues.
- `provisionAgentBrowserSkill` synchronizes the packaged `assets/agent-browser/SKILL.md` to `~/.agents/skills/agent-browser/SKILL.md` only for managed Electron. A hash manifest under the data root updates untouched copies and preserves user-modified conflicts. `withdrawAgentBrowserSkill` removes an obsolete copy only when its target path and current hash still match that ownership manifest; modified or unowned copies are reported and preserved.

## Integration

- Electron calls the installer and provisioner before starting managed OpenCode, then injects only the validated absolute binary path into the child environment.
- Settings uses installer status/repair through local-sender-gated Electron IPC.
- External OpenCode, standalone web, VS Code, and legacy Tauri do not invoke provisioning.
