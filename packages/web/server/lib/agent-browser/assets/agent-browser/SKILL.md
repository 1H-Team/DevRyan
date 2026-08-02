---
name: agent-browser
description: Drive DevRyan's in-app browser to inspect, interact with, and visually verify websites. Use when website work needs browser navigation, screenshots, DOM inspection, interaction, or a final visual check.
---

# Agent Browser

Use `devryan_browser` to verify website work in DevRyan's isolated browser lease. DevRyan creates the browser in the background; the user sees only an activity badge until they choose to observe it. Do not ask the user to open the browser panel first.

## Workflow

1. Start the target website and determine its reachable HTTP URL.
2. Call `devryan_browser` with `command: "open"` and pass the URL in `args`.
3. Inspect with `snapshot -i`, then interact using the returned element references. Take a screenshot when visual appearance matters.
4. After edits, reload or reopen the page and repeat the relevant checks. Report what you actually observed.
5. Always call `devryan_browser` with `command: "close"` when verification is finished, including after a failed check when possible.

Pass command arguments as an array. Examples:

```text
devryan_browser({ command: "open", args: ["http://127.0.0.1:3000"] })
devryan_browser({ command: "snapshot", args: ["-i"] })
devryan_browser({ command: "click", args: ["@e3"] })
devryan_browser({ command: "screenshot", args: ["--full", "/tmp/site.png"] })
devryan_browser({ command: "close" })
```

## Constraints

- Reuse the same lease throughout one agent turn; do not launch or connect a separate browser.
- Keep checks focused. Prefer interactive snapshots over repeatedly dumping the full page.
- Treat the browser as shared-login infrastructure: leases are isolated tabs, but all DevRyan browser tabs deliberately share the `persist:openchamber-browser` cookie partition. Do not sign out, clear cookies, or change account-wide state unless the user asks.
- A hidden lease is still live. Closing it promptly releases its webview, CDP connection, and daemon session.
