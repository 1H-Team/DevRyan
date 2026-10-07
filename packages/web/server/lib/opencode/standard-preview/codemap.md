# Standard Windows desktop preview

`application.js` composes the existing v2 facade, admission client, bounded event
hub/SSE handler, filesystem routes, settings normalizers and static UI in the
Electron process. `server/index.js` selects this composition before importing any
native bootstrap when `DEVRYAN_RUNTIME_MODE=standard-preview`.

`lifecycle.js` launches only the trusted absolute
`DEVRYAN_STANDARD_OPENCODE_BINARY`, checks stock OpenCode 2.0.20, isolates its
home/data/config/cache/temp directories under `OPENCHAMBER_DATA_DIR/runtime`,
requires authenticated loopback readiness, and owns restart/shutdown. It creates
no native bundle admission, confinement grant or termination receipt.

`providers.js` maps the existing API-key UI to stock integration operations;
OpenCode stores credentials, and DevRyan never reads secret credential values.
`capabilities.js` publishes explicit ordinary-preview feature availability.
Disabled native/revert/task/provider-OAuth/bot/browser/media/terminal routes are
refused before facade dispatch. The stock runtime remains an ordinary Windows
user process; project tools use that user's permissions.

The desktop installs its owner cookie through `issueLocalOwnerSession()` and
retains the existing deferred startup, readiness, restart and stop handle API.
The preview backend refuses LAN/tunnel/proxied requests. Native composition and
native release acceptance remain independent.
