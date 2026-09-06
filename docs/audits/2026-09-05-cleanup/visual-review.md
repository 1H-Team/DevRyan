# Reviewed runtime evidence

The first ten screenshots listed below were opened and inspected, not merely generated. Machine results remain in ignored cache; reviewed check timings and health counts are in `acceptance.json`. Each initial run had zero captured renderer console errors, zero diagnostic gaps and no cleanup error. These early results and reproductions remain historical evidence. The frozen final fixture coverage and applicable native evidence are recorded later in this document with their separate artifact identities.

## Electron

Run: `.cache/qa/electron-chat-bAZaT1/` using the repository Electron binary, actual main/preload and rebuilt shared UI resources. `chat-idle.png` shows the restored completed response, second cancelled user turn and reachable empty composer. The first response contains all twenty numbered chunks; an exact rendered-text assertion checks the full response, including off-screen text. Each canonical user message ID has exactly one DOM row after reload. The first response is partly above the viewport, consistent with the final turn being in view; this is not an old-history anchoring test.

Automated selection, four-session streaming, draft preservation, native CDP pointer submission, active cancellation, SSE reconnect and reload all pass. The Session Changes card explicitly reports absent fixture evidence. Its capture/export behavior is not accepted by this test. A prior screenshot caught only the startup splash because the runner checked stale DOM immediately after reload; that run was rejected and the runner now waits for navigation load and restored content before capturing.

## Web and responsive layouts

Run: `.cache/qa/web-mobile-Wqkt6H/` using the actual standalone Express server and shared web bootstrap in a sandboxed Chromium shell. The same chat/send/cancel/reconnect assertions pass. This web browser has no desktop preload. An isolated browser workspace preference is seeded before mount, matching the server fixture settings.

| Reviewed PNG | Observations |
|---|---|
| `light-390x844.png` | Portrait composer and controls visible; model available; closed session drawer outside viewport; session-change evidence explicitly unavailable. |
| `dark-390x844.png` | Same bounds and legibility in dark theme. |
| `light-844x390.png` | App uses its desktop breakpoint in landscape; composer remains reachable. Sidebar hover actions crowd the narrow project/session rows; unresolved visual finding F14. Session-change card caught in loading state. |
| `dark-844x390.png` | Same landscape geometry; unavailable evidence message fits. Sidebar action crowding remains. |
| `light-768x1024.png` | Tablet portrait uses mobile shell; composer fits and closed drawer leaves no strip. Session-change card caught loading. |
| `dark-768x1024.png` | Same tablet layout in dark theme; available model and evidence limitation visible. |
| `light-drawer-open.png` | Touch-opened sessions drawer occupies the intended width, with overlay and visible close control; no clipped strip after touch-close. |
| `dark-drawer-open.png` | Same touch drawer behavior in dark theme. |
| `chat-idle.png` | Resizing back to desktop restores the chat after cancellation/reload, with empty composer and completed first response preserved. |

Touch open/close was also asserted at both 390 and 768 widths in each theme. The final portrait/tablet closed positions are checked from drawer bounds. Page overflow and composer bounds passed in all six layouts. Earlier captures from `.cache/qa/web-mobile-iPibR0/` showed stale closed-drawer strips and false fixture recovery state and were rejected; they are not final acceptance evidence.

These checks do not accept every mobile interaction. Drawer swipe velocity, keyboard/tab order, permission dialogs, attachments, queue handling, history pagination/scroll restoration, real device keyboards and native integrations remain open. “Loading session changes” during an early snapshot does not prove a production hang; this fixture has no captured evidence, and later states report that limitation explicitly.

## F14 landscape session-row follow-up

The original landscape crowding finding was reproduced with a genuine long session title and native mouse hover. `.cache/qa/adapter-probes/landscape-hover-rgva6K/` contains the settled light/dark before screenshots: at 844×390, the clipped title ended at x=170 while Pin began at x=168, a 2px overlap. Both actions were fully opaque and hit-tested; two identical consecutive geometry samples excluded the hover transition.

The smallest padding correction is in `SessionNodeItem.tsx` and `sessionRowInteractionClasses.ts`. Rebuilt candidate `.cache/qa/candidate-web-XmxL0y/` (manifest SHA-256 `33e291bc1f84946e4de0a91dc34c080830d9ee38591a3cba908ed7c39ac84958`) was checked in `.cache/qa/adapter-probes/landscape-hover-1VzfDq/`. Both after screenshots were opened and inspected: the title now ends at x=158, leaving a 10px gap before Pin. Pin remains x=168–188 and Archive x=190–210; both 20×20 pointer targets are visible and hittable in both themes. This closes F14's measured title/action overlap only. The run had no captured console errors or unknown fixture routes; `visual-review.json` preserves the scoped result.

## F17 mobile agent opening tap

The native touch trace in `.cache/qa/adapter-probes/mobile-rich-feCpih/result.json` begins with Builder/Low at 390×844. Pointerdown and pointerup target the original Builder button. Pointerup mounts the agent sheet before touchend; 5.3ms later, the same gesture's trusted synthesized click targets Orchestrator inside that new sheet. The resulting composer shows Orchestrator/Default with the sheet closed. The session journal has no extra parent prompt; the earlier matching failed run's journal review records 38 parent records and zero gaps. This was an input-event bug, not intentional agent cycling.

After the click-activation correction, `.cache/qa/adapter-probes/mobile-rich-q7fw0z/` on candidate PvUPsj (manifest SHA-256 `d166c0ca05356f8f925acebde4a33dd05268c3fed818f94bdf7095e58d5e861a`) records the trusted synthesized click on the original Builder button; only then does the sheet open. The agent sheet screenshot was opened and inspected: Plan, Builder and Orchestrator fit the viewport, and Builder remains checked. Six native Tab steps enter the sheet, Escape closes it, and Builder/Low stays unchanged. This scoped run has zero renderer errors, unknown fixture routes, cleanup errors and journal gaps. `mobile-agent-touch-review.json` records the comparison. The encompassing smoke stopped later on the separate missing mobile Default choice; it is not full responsive acceptance.

## F18 mobile Default choice

On rebuilt candidate VoC1qS, `.cache/qa/adapter-probes/mobile-rich-DtrbOX/` and `mobile-rich-yT2dPj/` both use the native mobile model sheet to select High, submit it, select Default, submit an explicit empty variant, reload, and verify that the Default label and pressed chip return. These actions occur before the managed-task read fixture is installed. Default selection and restoration screenshots were opened and reviewed; the three choices fit the 390×844 sheet. The first run's `visual-review.json` records all 15 generated screenshots, including the completed portrait rich states and the later failed landscape capture.

This is scoped Default-selection proof. A cache-only wrapper waited for the fresh automatic Plan view and closed it through its native control while shared QA scripts were frozen. Both encompassing diagnostics stopped at the separate 844×390 reasoning-target reveal timeout, so neither is final six-state runner acceptance. Physical-device keyboard behavior and native task scheduling are not claimed.

## F19 unsent effort selection across resize

`.cache/qa/adapter-probes/mobile-rich-yT2dPj/responsive-selection-review.json` preserves the reproduction on the same frozen candidate. The opened before screenshot and DOM show Builder / Fixture model · Low at 390×844 after an explicit unsent Low selection. Clearing the emulated viewport to 1280×768 retains the mobile Low label briefly; the first desktop control sample shows Default, and every later sample agrees. The opened after screenshot shows that Default state.

The next native Send, `msg_070c6b1fa001tw0RsebpvFkDIl` in `ses_qa1`, records an empty raw variant and empty canonical model variant instead of `low`. Its journal prompt agrees and the journal has no gaps. The last preceding canonical user message was the intentional Default submission `msg_070c6a996001uSQ6KvOLNMQyZg`. The separate mobile and desktop JSX owners remount `ModelControls`, resetting its local history-restoration guard.

The independent `.cache/qa/adapter-probes/mobile-rich-6wPOMf/session-selection-review.json` holds the viewport at 390×844. After choosing unsent Low on A (`ses_qa1`), native sidebar clicks visit existing B (`ses_perfparent`) and return to A. A now shows Default. The next native Send, `msg_070d34c200013n0bEWYILhEVxR`, again records empty raw and canonical variants, with a matching journal and zero gaps. All three before/return/send PNGs were opened. This probe stops after that send and before any viewport change, so resize cannot explain it. At this stage the per-session restoration correction remained pending; a stable responsive footer alone would not cover this second case. The final fixture below exercises both regressions after that correction.

The negative Settings case is separate: `.cache/qa/adapter-probes/mobile-rich-omBrgH/settings-selection-review.json` opens and closes Settings at the same viewport. The exact model-button DOM element stays mounted, Low remains selected, and native Send `msg_070d659fc0015KD7n6nBBbXhTd` records `low` in both raw and canonical metadata. Its journal agrees and has no gaps. All four PNGs were opened, but the Settings image caught drawer-close motion and is not settled Settings visual acceptance.

## Real provider

`.cache/qa/live-DNN3Of/result.json` passed authenticated host HTTP send/stream/reconnect/cancel with the configured provider, 37 observed deltas and zero diagnostic gaps. It created and removed only its own synthetic session and logged out its own cookie. This used an already-running host, not the candidate bundle. There are no live-provider UI screenshots, so this does not close live UI acceptance.

## Frozen final fixture coverage

The final fixture cohort uses served UI `.cache/qa/candidate-web-dOSUpt/` (SHA-256 `5034563fa42eb937a6f35ddbc63ede8ba937302bba1441b9198b8daa5bc158f5`) and the actual packaged Electron 41.2.1 application in `.cache/qa/packaged-electron-NT1qd8/` (ASAR SHA-256 `ebd9237120adced16dbb321366907acb0892b9efede0fb7a58296896e4c2c46a`). Source fingerprint `f787a1f140317cf4db1ca6e09b03b6c0b63bce4447b6f427e930bfff4c1cae12` stayed unchanged throughout these runs. Electron records `isPackaged: true`, its real main/preload, private home/profile and the served `Resources/web-dist`; standalone web uses its own browser bootstrap without desktop preload. Each fixture profile pins its exact model and application agent before the first prompt, with no credential copy or global configuration read.

The original nine runs in `.cache/qa/final-fixture-dOSUpt-r3/` remain **eight passes and one failure**, with exit code 1. All **402 physical PNGs** were individually opened and subsequently rehashed against their assigned reviews. Electron Builder Default `yN5t90` passed 14 checks, then timed out waiting for the nested failed-tool disclosure. The saved frame shows its enclosing group collapsed; the original one-shot group-presence predicate was not recorded, and Enter was never reached. The gap-free journal records the expected failed tool and idle state. This does not establish broken keyboard behavior or a particular race. Five otherwise passing cells also had a superseded-plan screenshot that omitted its intended disabled control; their earlier DOM samples cannot establish what was visible when those PNGs were captured. Every original result and image remains preserved.

Six separately authorized full-scenario follow-ups in `.cache/qa/r3-supplemental-observer/` and `.cache/qa/r3-supplemental-observer-v2/` each pass all 25 original checks. All **216 supplemental PNGs** were individually reviewed, and every raw-result, inventory, image and review hash was checked again at closure. The six journals contain **9,564 records and zero gaps**, with no cleanup errors. Together with the three complete original passing cells, these runs provide coverage for the following nine distinct fixture cells:

| Fixture cell | Selected evidence | Passing checks | Individually reviewed PNGs |
|---|---|---:|---:|
| Web Builder Default | Original `g5z5UV` | 25 | 36 |
| Web Builder High | Supplemental `frrGkP` | 25 | 36 |
| Web Orchestrator Default | Original `T7xTVA` | 25 | 36 |
| Web Orchestrator High | Supplemental `5UKEei` | 25 | 36 |
| Electron Builder Default | Supplemental `oLFF8x` | 25 | 36 |
| Electron Builder High | Supplemental `Td4PV1` | 25 | 36 |
| Electron Orchestrator Default | Supplemental `4nliP0` | 25 | 36 |
| Electron Orchestrator High | Supplemental `6ubUTX` | 25 | 36 |
| Web Builder mobile | Original `n25LmH` | 40 | 137 |

This selection totals **240 passing checks and 425 reviewed images** across nine cell identities. It is a coverage mapping assembled from closed runs, not a rewritten nine-run result. Across the original cohort and all six follow-ups, **618 physical PNGs** were reviewed. The complete mapping, exact run directories, hashes, preserved failure and image gaps are in `.cache/qa/r3-supplemental-observer-v2/six-supplemental-fixture-coverage-closure.json` (SHA-256 `68e6502b173785352aef48b836c1e943d0f72d0a6ae1c311b87b84e27996c45b`). The final four-run review is `four-completion-review.json` in the same directory (SHA-256 `7b09e5257b29e06f20b1cb00750cc90dd511497971c4b0f462d92d5f85ed2495`).

The original cohort and first two follow-ups use runner fingerprint `efabcfe01caf0c1297500592c1fa1e7a1a2219b6915384efe0d56e578df56d25`; the last four use R4 fingerprint `5b9041364365ea8cac70a4fc321d80e740c1038f75d3a34b359e48ce75ff9a31`. R4 adds admission checks for credentials copied into live profiles and changes only related QA code/tests/documentation. Fixture branches, scenarios, production source, UI and packaged runtime bytes remain unchanged. Each run is checked against its own approved freeze. The quiet R4 full validation passed separately; the fixture review does not replace that gate.

## Follow-up observation limits

The supplemental wrapper calls the original exported runner with its full scenario, original actions and original timeouts. Its bounded CDP observer adds read-only DOM samples around the failed-tool and superseded-plan checks. It does not add screenshots, repair missing targets or retry actions. In `oLFF8x`, the original collapsed-group predicate and nested-tool focus both return true, the original Enter action reveals the configured error, and the next tool run recovers. All ten checks that the original failed run never reached also complete. This supplies new functional evidence without explaining the historical failure.

Every supplemental superseded-plan PNG visibly contains its intended control. Separate DOM traces establish its disabled state, exact superseded title and stable geometry from the successful predicate through the existing capture delay, animation frames and capture brackets. The observer itself consumes renderer time and adds command latency, so a passing follow-up cannot prove an original focus or capture race, an effort-specific problem or a product scroll defect. Screenshot/expression hashes inside the observer log were redacted by the shared sanitizer. Correlation therefore uses the complete ordered capture stream and the original successful runner's file-write order, plus independently rehashed physical PNGs; those physical hashes are not presented as recovered observer hashes. Both `comparative-capture-review.json` files retain these limits.

The deliberate rejected prompt, denied permission, failed tool and temporarily suppressed events are expected fixture states whose recovery is checked. Static screenshots alone do not prove focus, disabled semantics, submitted selection or lifecycle ordering; those conclusions use the corresponding DOM, raw requests, canonical records and archived journal. Historical automatic-continuation Builder badges are distinguished from the next actual user-selected Orchestrator turn.

## Final responsive scope

The final `n25LmH` mobile run passes all 40 checks and has 137 individually reviewed PNGs, covering its full core journey plus light/dark 390×844, 844×390 and 768×1024 layouts and rich interaction states. It exercises touch-opened agent/model controls, keyboard reasoning disclosure, permission/question handling, attachments, queueing, cancellation/reconnect, parent/child navigation and history loading. High→Default submission/reload passes. Separate actual sends prove that unsent Low survives desktop→mobile→desktop and A→B→A session navigation, with matching raw, canonical and journal selections. The final layouts include the corrected session-row and workspace-heading spacing; no additional actionable issue was identified in the reviewed images.

These are browser-emulated viewport and input checks. Real-device keyboards, swipe velocity and other unexercised device behavior remain outside their scope. Managed-task rows and repeated compaction records in this fixture are controlled data: they verify presentation, restoration and UI contracts, without accepting a native scheduler or a real provider's compaction behavior.

## Applicable native package evidence

`.cache/qa/native-acceptance/native-chooser-quit-Oi3VJf/visual-review.json` records the actual earlier `cxsg0V` package, with its original package-evidence SHA-256 `7289fd63d14433022a5bb6f0e9ebd98b6cebeaee3fb0cd520e4a96174802ac52`. Native file selection and chooser cancellation preserve both attachments. The single fixture submission carries the complete 700-byte text requirement and exact 1,095-byte PNG digest; Low agrees in raw and canonical records. Native File → Add Workspace and cancellation pass. Quit confirmation's Cancel and Wait preserve the session; Quit Now exits with code 0. All five archived renderer PNGs and the inline native chooser/quit views were inspected. Its journal contains 35 records with zero gaps, and its owned process identities are closed.

The submitted renderer frame already contains the completed response; it provides no in-flight image proof. The disabled-Bot QA profile reports unknown scheduler/checkpoint state in Quit confirmation, so active-Bot behavior is not accepted. The inline native views were inspected during the run and were not archived as local PNGs; they are not part of the 618-image fixture count.

The refresh from `cxsg0V` to `NT1qd8` changes exactly three approved server test files in the candidate archive. Its served UI, main, preload, QA bootstrap/policy, Electron executable/framework and native SQLite/PTY bytes are unchanged. The complete archive comparison is `.cache/audit/coding-agents-2026-09-05/test-refresh-package-pair-independent-review.json` (SHA-256 `39aa1d4d7891829f357ed4dec99d8ac7336c856956d4f9cee8c9aefd61684a90`). This establishes why `Oi3VJf` remains applicable to those unchanged native behaviors while retaining its original source/package identity. It does not become a new native run. Signing/notarization, updater installation, global protocol registration, real keychain, background Bots and legacy Tauri remain excluded.

## Closure and remaining acceptance

The final read-only process audit checked 464 retained PID/start identities across all nine original and six supplemental runs and found zero remaining owned identities. All runner executions exited, every private runtime was removed, and journals/project evidence were archived before the results were written. The exact closure is `.cache/qa/r3-supplemental-observer-v2/final-owned-process-closure-review.json` (SHA-256 `49caf2a9dc27cc894ee45c57bb3e7374cbfffdda31b517f7cd5e8e6fa118a130`). This records those fixture-owned processes only.

Final live-provider and performance acceptance remains separate. The planned native manual/natural compaction feasibility runs must establish their own boundaries and completed application behavior; they do not count toward the 96 final live scenarios. The quiet package plan still requires 24 resource runs, six session-memory runs, six interactive runs and six cold update-check hosts, with startup measured within those launches. Earlier smokes, fixture images and source-host diagnostics cannot substitute for those results. Current live/performance status belongs in `coding-agents-acceptance.md`; this document accepts only the completed evidence and scopes described above.
