# Model and recovery verification — 2026-09-14

Live checks used disposable Git fixtures and isolated DevRyan/OpenCode hosts. The original user's app and runtime were not stopped. Full trial outcomes, including failures, session IDs, tool counts, prompt variants, and cleanup evidence are retained in [matrix.json](matrix.json). Command outcomes are in [validation.json](validation.json).

## Live model coverage

| Parent model | Provider route | Builder | Orchestrator |
| --- | --- | --- | --- |
| GPT-6 Astra, medium | OpenAI | Passed read → RED → edit → GREEN | Passed managed discovery, implementation, collection and disposition |
| Grok 4.6, high | xAI | Passed read → RED → edit → GREEN | Passed managed discovery, implementation, collection and disposition |
| Composer 2.5 | Cursor SDK | Passed read → RED → edit → GREEN | Passed two native child tasks, child edit/test and parent verification |
| Fable 5.1, Extra High | Cursor SDK | Passed read → RED → edit → GREEN on the fresh runtime | Passed native discovery and implementation children, edit/test and parent verification |

OpenAI and xAI were checked on isolated OpenCode 1.18.30 and again on 1.18.31 after the concurrent workspace version update. The final Composer Orchestrator and Fable Builder checks used the completed Cursor changes on 1.18.31. Managed runs exercised OpenAI Explorer and xAI Fixer assignments, real filesystem changes, Context Mode calls, and terminal task acknowledgements. Cursor native children remain native task projections rather than DevRyan managed child-session records.

Native Anthropic/Claude Builder and Orchestrator runs were **unavailable**: neither supported credential source provided usable Claude access for the isolated profile. Cursor-routed Fable is separate evidence. A critical review was performed in Claude Desktop using Fable 5.1 with the UI's Extra effort setting.

## Changes established by testing

- Failed managed tasks no longer instruct the parent to explain model selection and recovery controls at length. The parent uses at most one brief status sentence; the task card owns progress and controls. Transport recovery no longer receives quota-specific prose.
- Every automatic backup attempt revalidates the configured provider, model, thinking level and catalog before acknowledging the result. Changing or removing a backup replans without dispatching the stale choice. The same child session and cancellation generation are retained; repeated configuration races remain bounded by five host failures.
- Confirmed missing quota backups fall back to primary reset/backoff scheduling. Unknown catalog availability defers in 30-second intervals for at most 90 seconds, or until the primary reset arrives. It then skips the unverified backup without consuming provider attempts or host failures. Host admission pauses and transport recovery retain their existing bounds.
- Cursor no longer certifies a still-running tool merely because its parent turn finished. Missing terminal results become explicit errors, or cancelled states after Stop. Nested tool previews settle at task completion, retain partial output, reject late reopening, and preserve confirmed completions. Persisted unfinished tools receive the same repair on read. Unknown edits are not replayed automatically.
- Evaluation accepts native OpenCode `exit` metadata as well as `exitCode`, requiring all reported channels to agree. A leading `cd` is accepted only for the exact runner-owned fixture directory followed by the exact test command. Error, malformed, conflicting and missing exit evidence still fails closed; the chronology grader is unchanged.

## Retained failures and limits

The baseline OpenAI/xAI Builder trials produced correct edits and passing filesystem tests but failed the old exit-metadata grader. Their original failed reports remain intact, alongside regrading with the corrected tool-evidence parser. The first Composer trial overlapped reads and the failing test and legitimately failed chronology grading. A later trial used a valid directory prefix that the old command matcher rejected.

One Cursor Orchestrator attempt failed at the API-key exchange endpoint. A Fable Builder attempt encountered unavailable SDK filesystem/shell execution; its missing results exposed the reporting bug above. Fresh runs subsequently passed. Another fresh Fable attempt stopped at model admission while SDK discovery was warming up, before creating a session; the subsequent admitted run passed. Its conservative failed cleanup projection is retained, and its owned fixture files were restored.

Intermediate repair trials temporarily included explicit sequencing guidance. That sentence was removed after review to preserve the original case definition. Each observed prompt variant is identified in the matrix. These are correctness checks, not paired performance measurements or evidence that a model's general reliability improved.

Recovery races, catalog failure paths, cancellation and retry limits were verified with deterministic fault fixtures. The live trials establish real model, tool, edit and child-task execution; they do not claim live quota exhaustion or automatic backup success against every provider. The isolated diagnostic journals contained no recorded gaps. Private provider-profile copies were removed after shutdown; journals and sanitized reports were retained separately.
