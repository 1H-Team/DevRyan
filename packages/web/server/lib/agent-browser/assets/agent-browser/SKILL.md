---
name: agent-browser
description: Drive DevRyan's in-app browser to inspect, interact with, and visually verify websites. Use when website work needs browser navigation, screenshots, DOM inspection, interaction, or a final visual check.
---

# Agent Browser

Use `devryan_browser` to verify website work in DevRyan's isolated browser lease. DevRyan creates the browser in the background; the user sees only an activity badge until they choose to observe it. Do not ask the user to open the browser panel first.

## Workflow

1. Call `devryan_browser` with `command: "open"` and omit `args` so the active branch's assigned preview is the authoritative target.
2. If the successful result reports that no preview is configured, start the target website, determine its reachable HTTP URL, and call `open` with that exact URL. Do not assume a fixed local port. When a preview is configured, explicit loopback URLs are automatically mapped to the preview origin while preserving their path, query, and fragment.
3. Inspect with `snapshot -i`, then interact using the returned element references. Use `inspect` for element existence, attributes, and computed styles. Take a screenshot when visual appearance matters.
4. After edits, reload or reopen the page and repeat the relevant checks. Report what you actually observed.
5. Always call `devryan_browser` with `command: "close"` when verification is finished, including after a failed check when possible.

Pass command arguments as an array. Examples:

```text
devryan_browser({ command: "open" })
devryan_browser({ command: "open", args: ["http://127.0.0.1:<actual-port>/dashboard?mode=review#summary"] })
devryan_browser({ command: "snapshot", args: ["-i"] })
devryan_browser({ command: "click", args: ["@e3"] })
devryan_browser({ command: "inspect", selector: '[role="tooltip"]', styles: ["animation-duration", "transition-duration"], attributes: ["data-state", "style"] })
devryan_browser({ command: "screenshot", args: ["--full", "/tmp/site.png"] })
devryan_browser({ command: "close" })
```

## Safe DOM inspection

Prefer `inspect` over caller-written `eval` for existence, computed-style, and attribute checks. Supply a CSS `selector`, optional `styles` containing CSS property names (including custom properties such as `--tooltip-duration`), and optional `attributes` containing attribute names. Omitted lists default to empty. Inspection fields are valid only for `inspect`; omit `args` or pass an empty array.

The result is JSON with `status`, `selector`, `matchCount`, `styles`, and `attributes`. A `found` result has exactly one match and the requested property values; an absent attribute is `null`. With zero matches, `status` is `missing`; with multiple matches, it is `ambiguous`. Both return empty property objects. Narrow an ambiguous selector before drawing conclusions. Invalid CSS selectors are input errors.

Inspection queries the selector and reads values synchronously in one page evaluation. It is read-only: it does not retry, reopen, hover, or otherwise change the page. Transient elements such as tooltips can disappear between tool calls. A `missing` result reports an observation; it does not mean the requested visual verification passed. Report what was absent and, if needed for the task, deliberately reproduce the intended interaction before checking again.

If animation timing requires custom `eval`, check every `querySelector` result before calling element APIs such as `getComputedStyle`. Perform the intended triggering action and the null-safe inspection in the same evaluation when possible; do not rely on a tooltip still existing from an earlier call. If rendering has not produced the element yet, report that absence instead of reading styles from `null`. Caller-written JavaScript failures remain failed tool calls; correct the script or use `inspect` rather than assuming the browser connection failed.

## Constraints

- Reuse the same lease throughout one agent turn; do not launch or connect a separate browser.
- Keep checks focused. Prefer interactive snapshots over repeatedly dumping the full page.
- Treat the browser as shared-login infrastructure: leases are isolated tabs, but all DevRyan browser tabs deliberately share the `persist:openchamber-browser` cookie partition. Do not sign out, clear cookies, or change account-wide state unless the user asks.
- A hidden lease is still live. Closing it promptly releases its webview, CDP connection, and daemon session.
