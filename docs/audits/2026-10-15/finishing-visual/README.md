# Retained finishing screenshots

The four unprefixed representative PNGs come from the historical
`native-plan-implement-uhjmsd` Plan → Implement run. The
[first review](../finishing-visual-review-first.md) and
[second review](../finishing-visual-review-second.md) record independent inspection
of all 60 captures across desktop/mobile and light/dark themes. The four files
retained here are a subset of that reviewed inventory.

| Retained image | Visible state and limits |
| --- | --- |
| [approval-before-390x844-dark.png](approval-before-390x844-dark.png) | Mobile dark approval-before state with the green implementation action. Historical conversation content above the viewport is cropped. |
| [result-designer-1280x800-light.png](result-designer-1280x800-light.png) | Desktop light completed Designer result with its Open Subtask control. This is a static conversation viewport. |
| [file-undo-1280x800-light.png](file-undo-1280x800-light.png) | Desktop light edited-files card showing Undone and Redo. The image does not establish filesystem restoration or a successful click. |
| [helper-settings-390x844-dark.png](helper-settings-390x844-dark.png) | Mobile dark helper settings with the selected smoke-write model and Reasoning: Default. Lower expiry choices and manual cleanup fall below the captured viewport. |

The run used UI entry `assets/main-D9TKxJF9.js`, SHA-256
`f918f8b7c21ff9a470e765e2b1f33bb081be9dbc552298895bd53330651fd039`.
The historical entry in the [Plan proof](../finishing-plan-implementation.json)
preserves its tested identities and journal summary. This run predates later receipt-status,
RPC-summary, native-finish-observation and local-header-binding corrections; it
does not qualify the current Plan cohort.

Four additional `final-` images come from the earlier header-bound
`native-plan-implement-inSRAR` run, whose report SHA-256 is
`bf898bf2857a13ed4198a7e9fbc4034cb77e9fe8959115f83a1527f7f42e670b`.
The root viewed each of these four images independently; the full reviews cover
the 60-capture inventory. This run uses the same UI entry bytes above and the
then-tested source identities retained in the Plan proof.

- [Final mobile dark approval](final-approval-before-390x844-dark.png)
- [Final desktop light Designer result](final-result-designer-1280x800-light.png)
- [Final desktop light file Undo](final-file-undo-1280x800-light.png)
- [Final mobile dark helper settings](final-helper-settings-390x844-dark.png)

Four `qa-apply-` images retain the current `native-plan-implement-PZhCNL` run,
report SHA-256 `e05bd8f5a48b69662197f13c17d255b70c7e6f6513428e3670cd1c9a1a29a038`.
The root viewed all four actual images; the two independent reviews retain the
complete 60-capture inventory. These use the same UI bytes and the corrected
QA-source cohort in the [Plan proof](../finishing-plan-implementation.json).

- [Current mobile dark approval](qa-apply-approval-before-390x844-dark.png)
- [Current desktop light Designer result](qa-apply-result-designer-1280x800-light.png)
- [Current desktop light file Undo](qa-apply-file-undo-1280x800-light.png)
- [Current mobile dark helper settings](qa-apply-helper-settings-390x844-dark.png)

The complete reviews found no blocking visual defect within the captured
viewports. Deliberate partial outcomes and provider errors belong to the fixture.
Some historical content and the mobile Plan footer are cropped or under the top
fade. Static screenshots establish visible presentation only; they do not prove
interaction, scrolling access, durable persistence, filesystem effects, or
execution authority.

## Finalizing component capture review — 2026-10-16

The separate `node tests/visual-reasoning/run.mjs` run completed from
`2026-10-16T00:36:53.054Z` to `2026-10-16T00:37:26.769Z`, with reported Git
revision `8dd32145509b08134c3a47248dd365cc6d84119e`. Its result is
`.cache/qa/reasoning-DrA6LB/result.json`, SHA-256
`b5672c1fb885921ec45ffd2f88420c08e240a83ff4167dd25d200f784bb0fbc7`;
the associated `host.log` SHA-256 is
`4ec2a74929f9e83cb5b92f1e98c1cf051a9cd17f9ee47db5c2be91b0a15007a1`.
The report records **15 passed checks and 14 screenshots**: 11 reasoning,
keyboard, reload and responsive checks plus four Finalizing presentation/stage
clear checks; 10 reasoning scenes plus the four retained Finalizing scenes below.
Console errors: **0**. Cleanup errors: **0**. Live provider: **not run**.

An independent reviewer opened all 14 actual PNGs with `view_image`. The raw
automated report retains `visualReview: pending`; this section records the
subsequent pixel review without rewriting that report. Both desktop Finalizing
captures show a readable status label below the controls. Both narrow captures
wrap the controls and retain a readable label with clear spacing. No overlapping
content or horizontal clipping was visible in those four scenes.

| Retained scene | Pixel finding | PNG SHA-256 |
| --- | --- | --- |
| [1440×900 light](finalizing-1440x900-light.png) | Finalizing is visible in the live region below the wrapped controls. | `8379e247f045a085b5d2b49528b975cbf949e38cc3a6d6000b2b0788549ffa9d` |
| [1440×900 dark](finalizing-1440x900-dark.png) | Finalizing is legible against the dark background with the same layout. | `ebb04b611626524feafbf6e7a3cc04609e26b54a1276d187b45c5669cb4c82b9` |
| [390×844 light](finalizing-390x844-light.png) | Finalizing remains visible below three rows of controls; no horizontal crop. | `58cce04508d946eb4da9e7aeeb395210bc39bd5a49d6d1932156cec1f728001b` |
| [390×844 dark](finalizing-390x844-dark.png) | The narrow dark scene retains readable controls and status with clear spacing. | `5b7b2b7364639598d13351e5e92a71d42195b61a1892c518974fdad3d0cc5921` |

The other 10 images were also inspected: `live-pending.png`,
`sorted-pending.png`, `live-expanded-cancelled.png`,
`sorted-expanded-cancelled.png`, and light/dark pairs at 390×844, 844×390 and
768×1024. Pending thinking labels, expanded reasoning order, wrapping and
composer layout were visually consistent. The short 844×390 captures naturally
end before the lower composer; visible text is not horizontally clipped. No
blocking visual defect was found within these captured viewports.

These are real production components rendered from **synthetic component
inputs** in Electron Chromium. The positive Finalizing stage supplies a complete
native-shaped presentation envelope to `isAssistantFinalizing` and displays the
real `WorkingPlaceholder`. The four checks use pointer input to select that
fixture stage, assert its positive gate and live label, check viewport width,
capture the scene, then select `send` and assert that leaving the fixture stage
removes the live label. The stage-clear result is a DOM assertion; no post-clear
PNG is retained. This run does not establish a real human-turn clear, end-to-end
native producer provenance, live provider behavior, or actual mobile browser
chrome. The earlier Plan capture inventories above remain separate evidence.

| Tested source | SHA-256 |
| --- | --- |
| `tests/visual-reasoning/run.mjs` | `7038ad52ea5ff48d20f725b4b8686d3f1c2c76d6b6e946538a0b9ceae464b96a` |
| `tests/visual-reasoning/status-fixture.tsx` | `c5cb65e6bf0e46b0c1d21443dcc498d7022b92211e7d5910fea90ca0cc4521e5` |
| `packages/ui/src/sync/session-presentation.ts` | `05cc860e11d65721b589964026f6fa7c8db23051d21f3399b24480bca054deb9` |
| `packages/ui/src/components/chat/message/parts/WorkingPlaceholder.tsx` | `9702c1bb963b3322d78e945cbd4e9919da6f016dd0defc7da757d7e62517a8f7` |
| `packages/ui/src/components/chat/message/parts/ReasoningGroup.tsx` | `bec8533e0fc6f51824aaa3890b3b7c069c945799ae09121144017e00d95b1c6c` |
| `packages/ui/src/components/chat/message/parts/ReasoningPart.tsx` | `abbb9fd4493381b58ac2f5164265339cec94a0ee4e74772e36d5089bf82ad89d` |

## Fresh Plan → Implement review, 16 October 2026

Run `native-plan-implement-3xTjNM` passed its 60 capture checks. Its report SHA-256 is `72ff8db435a218f266ff8bd433f3006176136810a4c9091870ee4f4e68f17d78`. The first 32 and final 28 actual images were independently reviewed in the linked review documents; all prior cohorts remain historical. The parent also viewed these five representative frames and retained exact copies. No blocking visual defect was found in the captured viewports.

The mobile-dark Redone frame shows all three files and Undo, with a loading footer still visible. That frame alone does not establish settled changes. File and conversation restoration assertions are separate from pixel evidence. These production UI captures use synthetic providers and desktop mobile emulation; they do not prove real mobile browser chrome or positive native Finalizing timing. The separate four status-component captures above retain their narrower scope.

| Representative image | SHA-256 |
| --- | --- |
| [continued-plan-incomplete-1280x800-light.png](finishing-3xtjnm-continued-plan-incomplete-1280x800-light.png) | `f44d53227605ce6cff0ce41cceb34e60707ca59bef928d791c696f91c7e89384` |
| [approval-before-390x844-dark.png](finishing-3xtjnm-approval-before-390x844-dark.png) | `bdf3acd715b27a50347ff93009099d5c607a7caa7670a972a39cc816983f1152` |
| [result-designer-1280x800-light.png](finishing-3xtjnm-result-designer-1280x800-light.png) | `ac7a99923f746d1ac6ea1ab8795cf4ae56ae9e91d2543a810ed95f1d6b4ebd98` |
| [partial-outcome-390x844-dark.png](finishing-3xtjnm-partial-outcome-390x844-dark.png) | `9a0096c972f79995b69e95b3f30e805cb98a936ea5f7a35bf6abd2ad72d58e2d` |
| [redone-390x844-dark.png](finishing-3xtjnm-redone-390x844-dark.png) | `ed2b72ac060088203255ecae028492d424b5ebbce238140135f841268d13ae00` |

## Post-drain Plan → Implement review, 16 October 2026

Run `native-plan-implement-b99xKE` passed the same 60 capture checks. Its report
SHA-256 is `6a8344578a2b69ff0346fcfab404c775a97a2af56f10010a2a92d47aea2e04ee`.
The parent inspected and copied these five actual frames. The incomplete Plan has
a visibly disabled approval action; the continued Plan enables approval. The
Designer result and deliberate partial outcome remain readable. No blocking
layout defect was visible in these captured viewports.

The mobile-dark Redone frame again contains three files and Undo alongside
“Loading session changes…”. A static frame does not establish whether that
loading state settles. The owning lane's restoration assertions are separate
from this presentation evidence. These are synthetic-provider runs in desktop
Chromium, including mobile emulation; paid providers and mobile browser chrome
remain separate checks. The linked independent reviews cover all 60 images.

| Representative image | SHA-256 |
| --- | --- |
| [Incomplete Plan, desktop light](finishing-b99xke-continued-plan-incomplete-1280x800-light.png) | `d74628e77d66be5119a7917e7cc3093908495715a53664b055f65f4cc0167735` |
| [Approval, mobile dark](finishing-b99xke-approval-before-390x844-dark.png) | `188e7812c72e2fac618a4dba90f3bca81111692891d44ed34ba8a892d8472810` |
| [Designer result, desktop light](finishing-b99xke-result-designer-1280x800-light.png) | `9bd29730a405973bb1f69b708afe4a9bc3770a49eefcdb0233ad116120427ad2` |
| [Partial outcome, mobile dark](finishing-b99xke-partial-outcome-390x844-dark.png) | `d17ae93ff4f01f7dae400227a95830363439639ffe565fa74087cf799e2ca4a4` |
| [Redone, mobile dark](finishing-b99xke-redone-390x844-dark.png) | `2a2f965f96433c3d85d1fdd9d849a811f1ef5e1449d12ebd80994919cdd8583b` |

## Registered-project correction: standard Plan run

The standard `native-plan-implement-KIuR6t` run passed on frozen native source
`82b7377b…` / package source `7ce90d35…`, with all 60 checks and restored helper
controls. The parent independently inspected these five actual images. The dark
mobile Redone frame still has a loading footer; one frame cannot establish its
duration or a persistent defect. The interrupted-turn error remains visible in
the historical Plan region; the disabled incomplete and enabled approved states
are distinct. All 60 images also receive separate first-32/final-28 reviews.

- [approval-before-390x844-dark.png](finishing-kiur6t-approval-before-390x844-dark.png) — SHA256 `188e7812c72e2fac618a4dba90f3bca81111692891d44ed34ba8a892d8472810`.
- [continued-plan-incomplete-1280x800-dark.png](finishing-kiur6t-continued-plan-incomplete-1280x800-dark.png) — SHA256 `38d25bac493c509179fbe97cf3f7319a42f61fce92c91c772e59214fed56bcfe`.
- [recovered-outcome-1280x800-light.png](finishing-kiur6t-recovered-outcome-1280x800-light.png) — SHA256 `d092f6b38fb0bc7d7d8a2de593943cf206148d071c66db5ea7ef39d2a02a70c0`.
- [redone-390x844-dark.png](finishing-kiur6t-redone-390x844-dark.png) — SHA256 `61eea8a981f052093c9c40e4547d1b5353b74736dcd790ac95858f06d8cb1e2e`.
- [helper-settings-1280x800-dark.png](finishing-kiur6t-helper-settings-1280x800-dark.png) — SHA256 `d866a13b951bc3dc371201493163a21a64c2c9de349df6c1f439bb96199bb852`.
