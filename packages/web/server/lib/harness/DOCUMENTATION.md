# Web Harness Host

The web harness host is initialized from the resolved `OPENCHAMBER_DATA_DIR`.
It records sanitized canonical and synthetic OpenCode events, prompt/control
records, lifecycle transitions, worktree receipts, and evidence transitions.
Prompt routes return `503` with `Retry-After` until initialization finishes and
after bounded shutdown draining begins. Health and static routes remain
available.

Diagnostics are always enabled and remain local until the user explicitly
exports a bundle.
