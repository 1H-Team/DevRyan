# DevRyan consensus finishing plan

Consensus reached on 2026-10-15 after the third Codex/Claude review and counter-evidence rounds. **Codex owns implementation and presents this plan. Claude remains the critical reviewer.** Claude explicitly confirmed no remaining substantive disagreement. [Visible confirmation](claude-consensus.jpg).

This supplements the two approved implementation plans; it does not discard their safety, ledger, release or acceptance requirements. The app is not release-qualified. No runtime fixes, paid prompts, commits, tags or publication were performed during this review. Only audit notes and review proof were added by Codex.

## Evidence baseline and corrections

The prior source cohort passed `validate:full` (4,147 UI tests, 6,977 web tests and 24 additional native-host tests), production build/bundle checks, the original 53-case Node package gate and the actual synthetic Plan → Implement lane. The latter covered partial repair, restart, file Undo/Redo and conversation Revert/Redo. These are observed passes for that cohort, not proof that newly found edge cases are correct.

The [retained review record](codex-claude-handoff-review.json) binds the source digest, report/log hashes and provenance limits. The validation exit zero was directly observed by the root execution tool; it was not inferred from silent output. The 946-record journal was independently scanned before owned payload cleanup; the retained scan is an observation, not surviving raw journal data. The [new 32-image review](plan-implement-qualified/visual-review-supplement.json), verified against actual files, supplements the prior documented 28-image review. All 60 distinct filenames are now explicitly covered. This does not retroactively expand the earlier review.

The 104.055s and 55.707s incident timings remain first-receipt-to-task-terminal lower bounds. Raw model completion was not recorded. The 1.08M input-token number is cumulative usage, not active context occupancy.

Withdrawn proposals remain withdrawn: blanket terminal-state relaxation, automatic continuation-budget reset, forcing OpenAI HTTP because WebSocket supposedly has no timeout, and treating provider-default reasoning as the helper's strict Default contract.

## Delivery and ownership

Preserve the existing working tree and other active work. Use GPT-6.1 Sol High subagents with explicit file ownership, then independently review their changes. Start with separate release, Cursor and runtime/safety slices; coordinate shared files through the root. Keep corrections independently revertible. No dependencies, new result collection action, mutable group store, automatic acknowledgement or editor-extension assets.

Focused owning tests accompany each slice. Integrate and freeze the final source before expensive qualification. Serialize heavy/native/live runs to avoid known fixed-port collisions and resource contention. A newly changed cohort is never covered merely by the old pass.

## 1. Repair release admission before attempting publication

- Classify legacy dispatch history using trusted workflow, event, source SHA and version identity. Handle actual legacy shapes without crashing; never hide known failed qualification or turn unknown proof into success. Bound pagination/jobs requests to the required rolling ten-release evidence and retain a complete/incomplete classification and request count.
- Exclude skipped jobs and positively proven queued-never-executed jobs. Actual steps, runner or original receipts can prove execution; do not universally require both runner and step fields. Missing or partial receipts from known executed failures remain unexplained failures. Preserve the two-unexplained-failures-in-ten fence.
- Separate workflow attempt, physical qualification execution ordinal and reused successful job copies. Resolve copied matrix siblings to their original producer/job/receipt instead of demanding a new artifact from the copy. A failed sample's retry must still use a fresh runner with identical bytes.
- Preserve **initial attempt plus at most two retries, solely for proven pre-app GUI prerequisite unavailability**, complete evidence, zero fixture attempts and safe cleanup. Unknown setup/product/evidence/cleanup failures do not gain a broad infrastructure exemption. Refusals stay inside the receipt-producing boundary.
- Resolve the candidate and freeze budget feasibility before tagging or creating a stable draft, then recheck at promotion. Require three fresh `macos-26` rehearsals of the same candidate DMG and exact intended source, plus separate frozen-baseline upgrade/rollback acceptance. Phase limits remain three times the slowest observation, with existing floors, and must sum to at most the 570s absolute smoke allowance after GUI admission. Setup has its own finite allowance; nested waits cannot reset smoke budgets or consume cleanup time.
- After promotion, retry only read-only updater discovery through the actual application parser for a bounded interval to tolerate feed lag. Retain staged/finalization/deployment proof. Missing original proof still stops for review; it cannot authorize rebuilding, replacing or uploading public assets.
- An older published release's no-op retry verifies release ID and original proof. Require it to be latest only when no newer release exists. Keep Windows append/full-scope proof separate.
- Preserve one finalize owner, first admitted SHA/version, immutable source/artifact binding, draft-only uploads, digest-equal retry success, digest-conflict failure, exact inventories, deployment checks and legacy updater compatibility.
- The supported promotion allowlist is only `DevRyan-<version>-arm64.dmg` for `desktop-macos-arm64`; a separately supported `full` lane adds the branded web tarball. Reject missing, unexpected, legacy-prefixed and extension assets. Keep unsupported full targets refused.
- Brand direct-download artifacts and separate the manual Developer-ID output from the canonical stable asset name. Repair competing manual writers without adding Tauri features. Keep candidate/final DMGs 14 days and small receipts 90 days; expiry never permits conflicting replacement.

Acceptance uses the real queued-cancelled/reused-job/legacy-dispatch API shapes, actual partial-only ZIP receipts, malformed/partial histories, wrong source, product failure, exhausted GUI retries, feed lag/wrong latest, older published retries and a bounded GET-only real-history dry run. No release writer is used for this diagnostic.

## 2. Correct Cursor's pinned SDK contract

- Match SDK 1.0.28's assistant-step boundaries. A running/partial tool update does not close an assistant text step; a completed tool does. Empty thinking deltas still create the SDK boundary; thinking-completed has its own semantics. Keep exact text/reasoning concatenation and strict final-part identity validation.
- Feed independent traces through the real pinned accumulator, then every adapter. In particular, `A → running tool → B → completed tool → C` must yield `AB / tool / C`; `A → empty thinking → B` must yield `A / thinking / B`, without duplication after persistence or reload. Do not manufacture the expected conversation from the desired final result.
- Preserve absent, explicit empty and final-only results, fully drained streams, callback-only nested activity, typed provider errors and real resolved `{status:'error'}` outcomes. Retain cancellation, overflow and partial-drain outcomes.
- Add the finite `cursor_final_association` sanitizer allowlist for IDs, bounded ordinals/counts/lengths, equality and enumerated inner cause. The generic error reason already survives; the missing detailed fields must survive the actual journal sanitizer without recording text.
- Keep strict stdout framing. Route SDK console logging to stderr at worker startup, retain bounded callback writes and propagate/drain pipe failures. Bound long provider error messages without killing unrelated persistent-worker sessions; preserve direct-send error name/code.

The owning adapter and publication tests are the A1 gate. A negative reproduction passing means it exposed the defect, not that the product passed.

## 3. Finish delegation, Plan, receipt and helper guarantees

- Fix `wait_any(until:'settled')` in both native owner and executor: only changed attention matching `changedTaskIds`, genuine new settlement or other authorized barrier can end the attached wait. Preserve scalar v1 semantics. Add a composed scheduler → owner → executor test with an unchanged parked child and a running sibling.
- Preserve atomic page acceptance/publication-candidate staging and follow-up/source-acknowledgement transactions. Collection requires exact canonical completed-tool publication of all required pages; disposition requires a later authorized assistant step. Keep exact task/cursor identities, partial-commit receipts and deterministic singular acknowledgements.
- Keep receipt-stage active entries until commit, or restore them after failure. Test a later batch item failing, late calls and retries. Retain true owner/lock-holder progress, mandatory I/O ownership and existing deadlines; no diagnostic heartbeat grants a health exemption.
- Translate supported legacy boolean `tools` maps at top-level and per-agent according to pinned semantics, existing aliases, explicit permission precedence and conflicts. Unsupported or ambiguous legacy restrictions fail with an actionable typed error instead of disappearing. Test actual frontmatter → snapshot → native configuration and effective permissions.
- Fail closed when Plan enforcement hooks/authority are absent. Deny unknown mutator effects and outbound shell network while preserving reviewed read tools, questions and read-only children. Test real local POST/push denial, write denial and approved implementation writes. On other platforms establish real read-only workspace visibility; refuse only unsupported confinement, not merely a platform name.
- Implement admission still requires the authoritative successful current revision, settled descendants, exact saved-source identity and the existing same-session approval handoff.
- Prove native automatic-compaction reachability and exact canonical objective/source → compaction → successor lineage in source and compiled fixtures. Add the owning server interface for verified membership if needed. Never admit `compaction_anchor` text, arbitrary synthetic markers, failed/pending tails or later human turns as proof. Keep the current UI's server-verified grouping.
- Preserve strict non-execution Undo proofs, exact cached restore identities, cancellation-generation checks and rechecks after awaited work and inside transactions. Qualify legacy Plan API selection, pruned/non-managed read policy, reused provider call IDs and unfinished retry stubs before changing their behavior.
- Skip automatic Docker catalogue acquisition before requiring Docker when no owned installation exists, and suppress dormant probes for installed-but-inactive profiles during Agents-only use; restore cached focus checks while explicit retry stays uncached. Preserve active Bot work, required retention, mounted Bots surfaces, explicit controls and Docker Engine. Qualify both dormant cases with owned sampling, not a global process claim.
- Open the title readiness window at owned startup-attempt creation, before restored jobs can fire. Bound readiness and idle-confirmation polling; clear on settlement/failure and never renew stale delegated authority. Preserve at most two model attempts within one 30s total budget, three failed persistence cycles with 1s/2s waits, busy waits not consuming attempts, and the durable paused candidate/source/count state. New accepted human input may reopen one bounded cycle; manual rename wins.
- Keep the shared helper selector, default `opencode/deepseek-v4.1-flash` with Default reasoning, and existing title job/outbox; the competing native title agent stays disabled. Do not repurpose notification `zenModel` or cleared Git fields. Surface fallback source for title/commit/PR, preserve PR client metadata, fail selection-revision changes with refresh guidance, and use only an authorized active-session model at Default reasoning. Local title fallback follows bounded model attempts; Git without an authorized model errors. Test failures through isolated fixtures, never by signing out saved accounts.
- Preserve original continuation admission: constructor-owned veto, native decision first, exact committed Synthetic/predecessor/objective/attempt/permit/controller/generation proof, no unresolved barriers, consume once and **consumed + pending ≤ 2**. Mirror native `hasProviderError` handling for late output-start events and add source/compiled setter coverage. Do not enable a third physical continuation or suppress ordinary pre-output retries.
- Keep OpenCode 2.0.26 pinned. Qualify API-key session WebSocket connect/idle/Stop with short fixture-only timing. The pinned session path has 15s connect and model-dependent idle bounds; establish the actual effective value before claiming 300s. HTTP's 120/300/900 limits are separate. No proven WebSocket 900s total cap is claimed.

## 4. Repair graders before spending on live qualification

- Helper: select all applicable prepared rows in a serialized exact session/agent window, then validate every row. Join physical sends on session/scope/request, require one prepared key and at least one send, and validate unique positive send ordinals. Allow legitimate retries. Wrong model/revision/reasoning/tools and unexplained rows fail qualification. Proven unrelated helper traffic is excluded; ambiguous same-agent concurrency is a scope gap. No new correlation schema is needed for serialized QA.
- State the measured claim precisely as no variant, no reviewed reasoning keys and zero tools. Rename misleading `optionsEmpty` evidence labels; do not infer every private provider option is absent.
- Title: projection alone cannot qualify durable naming. Require source-bound persistence; keep projection supplementary and distinguish earlier recoverable attempts from terminal failure/paused jobs. Do not count projection plus persistence as duplicate renames. The original compiled mutation/publication owner separately proves exactly-once persistence and restart restoration.
- Silence: map all canonical steps, validate every step belonging to the sampled user without variant filtering, and account for all applicable physical requests. Exclude only requests proven to another canonical turn, including later Implement traffic in the retained Medium window. Wrong effort/route, ambiguous attempts and unlinked requests are explicit gaps.
- Preflight the retained original Medium sample before any paid High/helper call. Successful `exercise` and `qualify-providers` must use the same issuer; Medium and owner grants are not transferred or reconstructed.

## 5. Measure and optimize without removing safety

Instrument actual publication-history reads, scheduler lock hold and realistic page-read costs first. Reuse immutable evidence only within one fenced invocation. Preserve fresh controller/credential/permit checks at physical use, pre-commit and during cancellation/staging/commit. Prove revocation races before removing repeated authorization reads.

Evaluate larger v2-only pages through projection, metadata slicing, fitting and native validation. Reuse existing cursors and preserve v1's 8KiB behavior. Fixed framing/metadata reserves come first; the final cap is exact minified escaped UTF-8 JSON under the existing native limits. Preserve required references, truthful committed receipts, Unicode boundaries, publication and later-step review. This is conditional performance work, not a correctness prerequisite or an unconditional two-call promise.

Native `tool_output` defaults remain 51,200 bytes / 2,000 lines, with model-output budgets derived from the same reviewed configuration generation. The exact serialized reply cap stays `min(48 KiB, native byte limit - 2 KiB)`. Reserve response capacity before effects, explicitly reject oversized fixed metadata, and never fabricate `metadata.truncated`, including `false`.

Repeat five paired cold/warm samples with pinned workloads, selections, source and artifacts. Use existing descendant resource sampling and start-identity fences, with optional Docker/FD/category work off and explicit owned paths. Add the narrow final-required-durable-receipt → same canonical idle → restored controls/two-frame UI join. Calibrate clocks and retain timing uncertainty; coarse resource ticks cannot resolve UI thresholds or prove every short-lived process launch.

Record host latency, CPU, RSS/physical footprint, observed subprocesses, RPCs, durable commits, model-facing bytes, buffers and return to idle. Distinguish cumulative usage, cache counters and active occupancy. The current v2 CPU/latency regression remains visible until a comparable measurement disproves it. Finalizing UI is added only if five valid matched post-receipt samples exceed 1s median or 3s worst, with the existing identity/progress/reconnect/settlement fences.

Keep 300s silence initially. The existing source/compiled native Timeout/read → retry:true proof already passes. A 120s post-output policy additionally needs route/model/effort qualification, physical chunk/heartbeat reset behavior, a genuine pre/post-output timer contract, Stop-before-timeout coverage and three representative High HTTP turns plus the original Medium sample. Observed gaps ≤60s alone do not prove policy behavior. If the full contract is not qualified, retain 300s and report why.

## 6. Final qualification on frozen source

Settle release version/signing intent before candidate bytes. Proposed next version is 2.0.13, checked again for availability. Preserve the existing signing policy meanwhile; any version/metadata bump belongs **before** final source freeze and qualification. Keep the manual signing lane distinct. No re-signing after rehearsal.

On settled source run focused owners, then one `validate:full`, production build, `bundle:check` and docs validation. Build a fresh native artifact because compiled owners change. Run source/compiled contract graphs and the complete original Node package gate. Use Vitest for Vitest files, including the managed read-lock test; Bun runner mismatches and negative repros are not owning-test passes or regressions.

Run actual same-session Plan → approved Implement with Fixer/Designer, real checks, partial recovery, restart, file Undo/Redo, conversation Revert/Redo, pending-title restart and clean shutdown. Retain the 480s Plan deadline, natural exit and strict registry settlement. Repeat all 60 captures, desktop/mobile in both themes, HTTP helper-save fallback and independent image review. Inspect journal coverage before payload cleanup and preserve sanitized receipts, source/manifest hashes, review notes and small representative screenshots in the audit.

## 7. Live acceptance and release qualification

Reuse V1 / QA1 and its saved sign-ins through the existing owned upgrade/resume workflow; preserve root-owned keeper continuity where applicable. Native/source changes require the normal updated qualification binding and manual admission for a new issuer. Never copy cookies, credentials or held grants or open owner grants through automation.

First complete the original Astra Medium / Cursor Grok 4.6 Medium replay and three held-out agent tasks in disposable projects, retaining Medium. Then the same issuer preflights Medium and performs the three High HTTP and helper physical samples. Verify actual selected helper model, Default reasoning, zero tools, naming durability and commit/PR generation. Apply the authorized installed helper setting only after isolated success. Use matched resource/idle samples; do not call desktop touch emulation proof of actual mobile browser-chrome movement.

For the supported macOS arm64 release: bind one committed SHA/version, build one candidate, run three same-byte rehearsals and frozen-baseline upgrade/rollback, perform GET-only pre-tag admission, then qualify the tagged final DMG under the frozen 570s budget. Preserve the exact asset allowlist, original release ID, signing/image checks, SSE and native request correlation, persisted/reopened history, journal coverage, cleanup and updater parser proof. Tag/publication remain the concrete external release step, not part of this review. Full scope, Windows append, long startup/service qualification and OpenCode 2.0.27 remain separate tracks; no unsupported lane becomes a pass.

Check disk before packaging. Finish with cache report and prune preview, preserve QA1/cited proof/active work, and remove only owned superseded payloads or downloaded artifacts.

## Explicit lower-priority dispositions

| Item | Disposition |
| --- | --- |
| Inline error plus failure card | Fix only exact duplicate turn/attempt/cause; retain distinct transport/retry failures. |
| Plan stale after a later turn | Qualify/document deliberate fail-closed behavior; selected history remains viewable. |
| Linux/Windows empty Plan workspace | Establish equivalent read-only visibility or return a typed refusal; platform tests, no blanket disable. |
| Host-owned context-cache writes | Document the cache/workspace/Undo boundary; defer blanket cache lockdown because reviewed read tools use it. |
| Missing Plan hooks | Fail closed; constructor coverage. |
| Browser/lane/cleanup concurrent failure | Retain the original lane failure and attach bounded typed secondary errors; independently attempt cleanup. |
| Long Cursor errors/direct-send types | Fix in the Cursor slice; all adapter coverage. |
| Receipt active entry removed before commit | Fix with rollback/late-call coverage. |
| Quadratic wait overflow fitting | Measure realistic selected task counts first; optimize only if demonstrated, no new arbitrary launch cap. |
| Disposition repeated under a new objective | Document the intentional objective/generation conflict. |
| Preparation/X5 documentation overclaims | Correct owning documentation. |
| Codemap prompt leftovers | Remove stale instructions, retain exact search references, run bundled-agent contract/prompt-budget tests; no codemap files. |
| Manual DMG/legacy artifact names | Fix branding/writer isolation; resolve signing intent before candidate bytes. |
| Legacy Plan agent selectable through API | Qualify host Plan metadata or explicit refusal; fix if neither holds. |
| 20k compaction-buffer default | Defer tuning until measured; retain explicit native-buffer precedence. |
| Buffer wiring/negative/fractional cases | Add focused wiring and validation tests. |
| shell.deleted | Intentionally classify if emitted by pinned runtime; test with created/exited. |
| Old session-changes key left loading after scope switch | Clear only the stale scope/key; race regression. |
| Output-start after provider error | Mirror pinned native behavior; source/compiled setter case. |
| Unpublished staged final result page | Document safe recollection from page one; defer optimization because no automatic effects/acknowledgement occur. |
| Missing Verification heading | No change: headings never prove authoritative successful completion. |
| Never-settled native retry stub | Reload/disabled-approval qualification; adjust projection only if needed. |
| Older published release no-op | Verify original release ID/proof and account for a legitimately newer release. |
| Fourteen-day candidate-to-tag window | Document retention and expiry; never rebuild as proof substitution. |
| Docker with an installed profile | Suppress dormant installed-inactive Agents probes as well as the no-install path; preserve active work, required retention and explicit controls, without stopping Docker. |
| Title idle-confirmation poll | Bound within existing readiness/task deadlines. |
| Optional helper capture authority | Fail closed on missing revision/authority. |
| Availability reported as unauthorized | Correct typed classification; qualify fallback timing budget. |
| Grouped direct-finish journal attribution | Document existing per-call durable attribution. |
| Pruned/non-managed Plan read policy | Qualify reviewed reads and fix only demonstrated wrongful denial. |
| Windows append/full npm proof gaps | Document and qualify in separate explicitly supported lanes. |
| Reused provider call IDs/cancel markers | Add identity-scoped qualification; never globally relax cancellation proof. |
| Keychain command failure detail | Strip command/argument material before logs/journal; test with synthetic secrets. Document the existing OS CLI argv limitation, without credential reads or Keychain changes. |
| Cloudflare process from deterministic tests | Separate concurrent task; preserve its work and do not fold unrelated edits into these slices. It is not silently counted as this plan's completed fix. |

No paid or hosted release acceptance is claimed by this plan. The confirmed source defects and required post-fix qualification remain outstanding work.
