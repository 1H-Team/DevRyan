# packages/web/src/

## Responsibility
Browser bootstrap layer for the shared UI: wires runtime API adapters, service-worker behavior, and web-specific startup for main app, mini-chat, and detachable-browser entrypoints.

## Design
- **Adapter-first UI boot**: exposes `RuntimeAPIs` on `window.__OPENCHAMBER_RUNTIME_APIS__` before loading `@openchamber/ui/main`.
- **Environment-gated PWA behavior**: browser production registers the PWA service worker; desktop/Electron and development startups unregister stale registrations through `pwa-service-worker.ts`.
- **Thin entrypoint strategy**: app logic lives in shared `@openchamber/ui`; this directory only provides web runtime glue.
- **Browser pop-out entry**: `browser-main.tsx` initializes web runtime APIs before loading the shared `renderBrowserPopoutApp`; `vite.config.ts` emits it through the dedicated `browser.html` input.

## Flow
1. `main.tsx` constructs runtime APIs via `createWebAPIs()`.
2. Runtime APIs are attached to global window for shared UI consumption.
3. Shared UI module is dynamically imported.
4. Service worker registration/unregistration runs after load and prerender checks.

## Integration
- Consumes API adapters from `src/api/*`.
- Imports global UI styles/fonts from `@openchamber/ui`.
- Connects to backend routes exposed by `packages/web/server` through adapter modules.
