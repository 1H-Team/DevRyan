# Agent-browser ⇄ CDP bridge compatibility spike (revalidated 2026-08-02)

Go/no-go gate for the in-app browser CDP bridge (`packages/electron/browser-cdp-bridge.mjs`). The current run used `agent-browser` **0.33.2**, headless Chrome 150 on loopback port 19223, and a temporary WebSocket logging proxy on port 19224. The CLI connected with a direct page WebSocket URL, matching the capability URL emitted for a DevRyan lease.

## Verdict: GO

`agent-browser connect <ws-url>` works against a bare page websocket with no HTTP CDP discovery. Navigation, `snapshot -i`, and screenshot capture all succeeded. The temporary CLI daemon/session, Chrome process, and logging proxy were removed after the run.

The revalidation also exposed a host bug unrelated to the protocol: a `ws` server created with `port: 0` does not have an address synchronously. The bridge must await its `listening` event before publishing a port or capability URL. Tests must model that asynchronous lifecycle; a synchronous fake address can hide the failure seen with the real server.

## 0.33.2 connect-time handshake

```text
-> Runtime.evaluate                                   (root page probe)
-> Target.setDiscoverTargets {discover:true}          (root)
-> Target.getTargets {}                               (root)
-> Target.attachToTarget {flatten:true, targetId}     (root) -> sessionId
-> Runtime.evaluate                                   (session-scoped)
-> Page.enable / Runtime.enable / Network.enable      (session-scoped)
-> Target.setAutoAttach {autoAttach:true,flatten:true} (session-scoped)
-> Runtime.runIfWaitingForDebugger                    (session-scoped)
-> Browser.getVersion                                 (root, repeated before operation batches)
```

Everything after attach uses flat-session messaging. Browser operations exercised `DOM.*`, `Accessibility.*`, `Runtime.*`, `Input.*`, `Page.navigate`, and `Page.captureScreenshot` through the direct page connection.

## Bridge requirements

1. **Shared asynchronous listener:** one loopback WebSocket server is shared by all leases and is considered usable only after `listening`. Stop it after the final lease closes.
2. **Per-lease capability:** each lease has a distinct `/devtools/page/<token>` path, pinned guest, controlling client, synthetic target ID, CDP session ID, and in-flight budget. A bad token or second client cannot affect another lease.
3. **Synthetic root layer:** answer `Browser.getVersion`, `Target.setDiscoverTargets`, `Target.getTargets`, `Target.attachToTarget`, and `Target.detachFromTarget` around exactly one pinned guest per lease.
4. **Session routing:** strip the synthetic `sessionId` before `webContents.debugger.sendCommand(method, params)`, then restore it on replies and debugger events.
5. **Browser-level domain fence:** synthesize in-session `Target.setAutoAttach` as `{}` and reject every other session-scoped `Target.*` or `Browser.*` method. Forwarding those page-debugger domains could enumerate, attach, or mutate sibling Electron targets and windows; main-frame snapshot and interaction do not require them.
6. **Input attribution:** tag intercepted `Input.*` activity with the owning `leaseId`; Electron emits it only to the window currently observing that lease.
7. **Reconnection coverage:** a reconnect test must repeat the attach handshake and a real session-scoped command. Merely accepting another socket does not prove that target/session state was rebuilt.

## Packaged Electron acceptance (2026-08-02)

The bridge was exercised through the packaged arm64 Electron app against a lightweight four-page site served from `/Users/zoubair/Repositories/test/site`:

- Builder root `ses_03c355d96ffepzQFIKbeTEGhzI` used one lease across repeated Home, About, Work, and Contact navigation/snapshot operations. The root-scoped menu contained one row throughout the turn, and selecting it displayed the matching real Electron `<webview>`.
- A second independent Builder root, `ses_03c2d8ae4ffe61zUVleR731GjF`, concurrently opened About, captured its interactive tree, saved `/tmp/devryan-about.png`, navigated to Contact, and explicitly closed its lease. The selected root menu exposed only its own row.
- The first Builder edited the live site (coral homepage accent, `SMALL SITES, THOUGHTFULLY MADE.` heading, and a Latest Note card), then re-opened the site and visually verified the changed page through the same browser tool.
- Acceptance exposed a compositor-specific gap that the Chrome spike could not: `Page.captureScreenshot` stalled while the inactive lease `<webview>` used CSS `visibility:hidden`. Lease panes and the closed context panel now remain full-sized and paintable with `opacity:0`, z-order isolation, and `pointer-events:none`.
- Builder root `ses_03c262be5ffeBNlV6r91rTeW7X` then proved the repair without user observation: while the separate manual browser tab remained selected, it opened Work, captured the interactive tree, saved `/tmp/devryan-hidden-capture.png`, and explicitly closed the lease. The journal recorded no capture timeout or diagnostic gap.
- The visible activity presentation is intentionally generic (`Using DevRyan Browser`). The header uses a small count-free blue dot, and switching to a root with no lease removes that root-scoped indicator.
- Agent Browser Control settings reported expected/installed version `0.33.2`, status `Ready`, and a global active count that changed from `1` to `0` after the Builder's explicit close.

Static bridge/runtime coverage exercises distinct guests, capability isolation, debugger conflict handling, explicit close, idle cleanup, shutdown cleanup, and the two-minute orphan fence. The remaining optional hardware acceptance is to hold a real abandoned Electron guest for the full orphan interval while independently observing process-level resource reclamation; the deterministic fake-clock bridge test already covers that transition.
