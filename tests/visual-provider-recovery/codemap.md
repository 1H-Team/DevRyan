# Recovery UI fixture

`main.tsx` mounts the real shared recovery card and a completed managed dispatch row with a long model display name. `fixture-api.ts` replaces only
the host API using a Vite alias (the SDK alias selects its browser client), with explicit simulated status, disconnect and
reconnect controls. It never connects to OpenCode or a provider.

Run from the repository: `bunx vite --config tests/visual-provider-recovery/vite.config.ts`.
Open http://127.0.0.1:4189 and check status, Stop, errors, reconnect, and explicit
continuation. This verifies the shared component, not native shell integration.


The Claude timeout and uncertain-edit controls verify provider-specific wording,
zero-attempt attention state, Stop, and explicit continuation using the same
shared component. No provider or SDK conformance is inferred from this fixture.

The **Recovered child, failed parent** control shows a completed result without either parent-resume notice. Verify that the host card leaves no empty space and stays hidden on disconnect. Other failure controls retain Stop and explicit continuation. Check desktop and mobile message-column alignment. The fixture substitutes only the recovery API and has no provider or installed-app access.
