# Memory decision — September 6

**Do not add persistent memory for the current Plan defect.** The reproduced failure was loss of authoritative Plan selection after compaction/reload, with incomplete maintenance continuation policy. It did not demonstrate loss of the saved plan or canonical session records.

The implementation now retrieves bounded authoritative user/part records, defers restoration while authority is missing, preserves explicit user choices, and carries applicable Plan instructions through managed automatic continuations. Exact managed maintenance output cannot become a new actionable plan or produce a plan-ready notification; native compaction continuation preserves existing Plan-card behavior. Explicit Implement Plan remains the transition to implementation. These changes retain the existing settings and saved-plan formats; no new memory store, database migration or compatibility-identifier change is introduced. The fresh full lint/type/test gate passes. Native two-boundary acceptance is reported separately in [Coding Agents acceptance](coding-agents-acceptance.md).

The earlier xAI retrieval study contains three fresh compacted/control pairs. Each compacted arm read its exact saved revision-2 plan and all six preserved the planning pause. Five arms passed; the last compacted arm failed because it opened an unanswered native approval question after reading the plan. Its original outcome and differing generated plans remain preserved. This supports neither a universal retention claim nor a need for a new memory layer. Review: `.cache/qa/diagnostic-VoC1qS/retrieval-xai/study-review.json` (4,862 gap-free journal records and 41 reviewed screenshots). Its originally incorrect process-cleanup reports and subsequent verified cleanup remain explicit in the historical acceptance record.

A new suspected context-loss defect requires three fresh matched compacted/control pairs with the same source, profile, prompts and policy before escalation. Follow the approved order:

1. Verify authoritative records and correlation IDs; qualify missing or gapped evidence.
2. Repair retrieval or restoration from those records when it is incorrect.
3. Use bounded native context only if a reproducible need remains.
4. Consider a conditional checkpoint only after the preceding stages fail under controlled evidence.

Memory retention after loading, leaving and deleting sessions is a separate performance requirement. The fresh measurement stopped after the initial checkpoint when pagination could not establish canonical rendered coverage. No retention comparison or leak conclusion is available. See [performance](performance.md).
