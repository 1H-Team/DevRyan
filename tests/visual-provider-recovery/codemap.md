# Recovery UI fixture

`main.tsx` mounts the real shared recovery card. `fixture-api.ts` replaces only
the host API using a Vite alias, with explicit simulated status, disconnect and
reconnect controls. It never connects to OpenCode or a provider.

Run from the repository: `bunx vite --config tests/visual-provider-recovery/vite.config.ts`.
Open http://127.0.0.1:4189 and check status, Stop, errors, reconnect, and explicit
continuation. This verifies the shared component, not native shell integration.
