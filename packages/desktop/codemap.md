# packages/desktop/

## Responsibility
Legacy Tauri desktop shell retained for update continuity/migration support. It provides equivalent shell capabilities (windowing, menus, updater hooks, native commands) for already-released Tauri users.

## Design
- **Maintenance-only shell**: feature parity where required, but Electron is the forward implementation.
- **Rust command host**: `src-tauri/src/main.rs` contains command handlers, menu dispatch, lifecycle control, and app state.
- **Sidecar-oriented runtime**: manages OpenCode sidecar process and background services rather than embedding the web server in-process.
- **Module split for SSH orchestration**: `remote_ssh.rs` isolates remote instance config/state machine, port forwarding, process supervision, and status eventing.
- **Capability config**: Tauri capabilities and conf files gate permission surfaces per build/runtime.

## Flow
1. Tauri app boots and builds window/menu shell in `main.rs`.
2. Runtime starts/coordinates sidecar backend and tracks app-level risk state (e.g., quit confirmation conditions).
3. Webview invokes Tauri commands; Rust handlers execute OS/process/network operations.
4. SSH manager monitors remote sessions, updates phases, and emits `openchamber:*` status/log events to the UI.
5. Quit/update flows coordinate graceful teardown of sidecar and managed resources.

## Integration
- **Depends on**: Tauri v2 runtime/plugins, Rust crates, sidecar binary build chain.
- **Shared UI contract**: same `openchamber:*` event semantics expected by renderer compatibility layer.
- **Build pipeline**: `packages/desktop/scripts/*` handles sidecar build/dev orchestration and Tauri dev/build wrappers. The legacy bundle carries the canonical filtered web `default-config` as a resource and passes its validated location to the compiled sidecar; it does not maintain a second defaults tree.
- **Release role**: exists to preserve upgrade path until Tauri→Electron cutover is complete.
