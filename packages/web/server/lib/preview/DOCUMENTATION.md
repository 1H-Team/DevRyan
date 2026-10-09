# Preview module documentation

## Scope

The preview proxy supports a project app running on the same host as the DevRyan server, including viewers who reach DevRyan through a Cloudflare or managed tunnel. Tunnel and unknown-public registration requires a live project grant; the proxy stays loopback-only. The routing and isolation rules are in `codemap.md`.

A remote DevRyan host previewing an app that runs on an individual user's laptop is not supported. Only a design proposal exists.

History: [remote-user laptop relay proposal (not built)](../../../../../docs/audits/2026-09-07/preview-remote-relay-proposal/README.md).
