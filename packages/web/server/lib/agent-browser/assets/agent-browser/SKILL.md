---
name: agent-browser
description: Inspect and visually verify websites with DevRyan's managed browser tool.
---

# Agent Browser

Use `devryan_browser` to verify website work in DevRyan's isolated browser lease. DevRyan creates the browser in the background; the user sees only an activity badge until they choose to observe it. Do not ask the user to open the browser panel first.

## Workflow

1. Call `devryan_browser` with `command: "open"` and omit `args` so the active branch's assigned preview is the authoritative target.
2. If the successful result reports that no preview is configured, find a local site that is already running: read the project's dev script for its port and probe it (for example `curl -sI http://127.0.0.1:<port>/`). Call `open` with that exact URL. Do not assume a fixed local port. Do not start a dev server for verification: a process started from a tool command stops when that command ends, so it cannot serve later browser calls. If nothing answers, ask the user to start the site (for example with a Project Action) and share its URL, and report visual verification as blocked until then. When a preview is configured, explicit loopback URLs are automatically mapped to the preview origin while preserving their path, query, and fragment.
3. Inspect with `snapshot -i`, then interact using stable CSS selectors. Element references are valid only while the same daemon and document remain alive (see sequences below). Use `inspect` for element existence, attributes, and computed styles. Take a screenshot when visual appearance matters.
4. After edits, reload or reopen the page and repeat the relevant checks. Report what you actually observed.
5. Always call `devryan_browser` with `command: "close"` when verification is finished, including after a failed check when possible.

Pass command arguments as an array. Examples:

```text
devryan_browser({ command: "open" })
devryan_browser({ command: "open", args: ["http://127.0.0.1:<actual-port>/dashboard?mode=review#summary"] })
devryan_browser({ command: "snapshot", args: ["-i"] })
devryan_browser({ command: "click", args: ["#save"] })
devryan_browser({ command: "inspect", selector: '[role="tooltip"]', styles: ["animation-duration", "transition-duration"], attributes: ["data-state", "style"] })
devryan_browser({ command: "screenshot", args: ["--full", "site.png"] })
devryan_browser({ command: "close" })
```

## Comparisons and recording (0.38.1)

Use `command: "sequence"` for state that must survive across actions. A sequence
runs 1–32 ordered steps on one lease and daemon, within a total timeout of at most
120 seconds. Steps use the same `command`, `args`, `selector`, `styles`, and
`attributes` fields as ordinary calls. Nested sequences are forbidden; `close`
may appear only last. The whole sequence is validated before acquiring a lease.
Results contain zero-based step indexes. Execution stops at the first error and
returns completed results and `failedStep`; actions are never automatically
replayed. A failed action may have changed the page: inspect before retrying it.

Confined calls end their owned daemon at exit and may release the guest. Put
`open` and all dependent actions in the same sequence. For initial exploration,
use a sequence containing `open` and `snapshot -i`; in a later planned sequence,
open the target again and use stable selectors. Do not assume transient page state
survives separate calls. Reacquire refs and comparison
baselines after that boundary. Within one daemon, refs survive snapshots and
same-document updates of the same element; reacquire after element replacement,
navigation, or close. Use stable selectors in a planned sequence: steps cannot
substitute previous outputs or run a scripting language.

```text
devryan_browser({ command: "sequence", steps: [
  { command: "open" },
  { command: "snapshot", args: ["-i", "--delta"] },
  { command: "click", args: ["#details", "--human"] },
  { command: "snapshot", args: ["-i", "--delta"] },
  { command: "screenshot", args: ["--if-changed", "before.png"] },
  { command: "click", args: ["#save", "--human"] },
  { command: "screenshot", args: ["--if-changed", "--threshold", "0.01", "after.png"] }
] })
```

`snapshot --delta` first returns full state, then unchanged or structural changes.
Use `snapshot --delta --full` to refresh the baseline. Ordinary snapshots remain
full by default. `screenshot --if-changed` writes only changed images;
`--threshold 0–1` sets the maximum changed-pixel ratio counted as unchanged.
An unchanged result is successful and produces **no new image path**. Ordinary
screenshots still always capture. Per-action `--human` adds natural pointer
movement/timing to supported pointer actions; session input mode stays host-owned.

Recording needs Settings → Agent Browser Control → Repair to provision managed
FFmpeg. A recording dependency failure does not disable ordinary browsing.
Start/restart/stop must finish in the same sequence in confined execution:

```text
devryan_browser({ command: "sequence", timeout_ms: 120000, steps: [
  { command: "open" },
  { command: "record", args: ["start", "demo.webm", "--fps", "30", "--cursor", "--contact-sheet", "--contact-sheet-threshold", "0.05"] },
  { command: "click", args: ["#details", "--human"] },
  { command: "wait", args: ["500"] },
  { command: "record", args: ["stop"] },
  { command: "close" }
] })
```

Use `.webm` (VP8) or `.mp4` (H.264), FPS 1–60. `record restart` within a running
sequence finalizes the previous file and begins the next. `--cursor` records an
inert pointer; DevRyan suppresses its own overlay while capture is attached.
`--contact-sheet` creates a timestamped PNG of distinct changes beside the video.
On errors or cancellation, bounded cleanup attempts `record stop`; errors report
`recordingFinalized` with cleanup output, or `recordingIncomplete` if it failed.
Do not claim an incomplete video is playable. Native process cleanup still runs.

Relative output goes to the confined execution cache, outside published project
changes. Use an authorized absolute path in the private project view only when
an artifact should be published with that tool call. Read/review the reported
screenshot, video, and contact sheet before claiming visual acceptance. Preserve
existing file-publication rules and report only files actually produced. WebMCP,
connection/trust configuration, tab pinning, and session-wide input settings are
not available through this tool.

## Safe DOM inspection

Prefer `inspect` over caller-written `eval` for existence, computed-style, and attribute checks. Supply a CSS `selector`, optional `styles` containing CSS property names (including custom properties such as `--tooltip-duration`), and optional `attributes` containing attribute names. Omitted lists default to empty. Inspection fields are valid only for `inspect`; omit `args` or pass an empty array.

The result is JSON with `status`, `selector`, `matchCount`, `styles`, and `attributes`. A `found` result has exactly one match and the requested property values; an absent attribute is `null`. With zero matches, `status` is `missing`; with multiple matches, it is `ambiguous`. Both return empty property objects. Narrow an ambiguous selector before drawing conclusions. Invalid CSS selectors are input errors.

Inspection queries the selector and reads values synchronously in one page evaluation. It is read-only: it does not retry, reopen, hover, or otherwise change the page. Transient elements such as tooltips can disappear between tool calls. A `missing` result reports an observation; it does not mean the requested visual verification passed. Report what was absent and, if needed for the task, deliberately reproduce the intended interaction before checking again.

If animation timing requires custom `eval`, check every `querySelector` result before calling element APIs such as `getComputedStyle`. Perform the intended triggering action and the null-safe inspection in the same evaluation when possible; do not rely on a tooltip still existing from an earlier call. If rendering has not produced the element yet, report that absence instead of reading styles from `null`. Caller-written JavaScript failures remain failed tool calls; correct the script or use `inspect` rather than assuming the browser connection failed.

## Constraints

- Reuse the same lease throughout one agent turn; do not launch or connect a separate browser.
- Keep checks focused. Prefer interactive snapshots over repeatedly dumping the full page.
- Browser leases isolate tabs, not necessarily login state. Ordinary agent leases share a cookie partition; assigned branch previews use an owner-and-origin partition, and manual browsing uses a separate host-and-principal partition. Do not sign out, clear cookies, or change account-wide state unless the user asks.
- A hidden lease is still live. Closing it promptly releases its webview, CDP connection, and daemon session.
