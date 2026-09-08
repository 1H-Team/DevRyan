# Session changes visual fixture

Mounts the production session changes card and revision diff dialog against
synthetic session A/B results. No provider, user runtime, or credentials are used.
Run `bunx vite --config tests/visual-session-changes/vite.config.ts` (port 4196).
Check expanding rows, recorded diff, Undo confirmation/Redo, independent session
switches, incomplete coverage, and Retry with retained files. The production
visibility rule hides empty loading/failure/partial summaries, submitted planning
(including earlier changes), and active implementation. Toggle empty capture,
submitted plan mode, and working to exercise these states, along with
narrow layouts. The structural-update counter verifies the card notifies
its scroll owner when its contents change. This verifies presentation;
the harness and host tests verify actual Git capture and restore behavior.

Large-list mode exercises bounded page navigation and the total file count.
Diff fixtures use the same paged response contract as production.

The fixture includes independent working-session, selected-child, segmented-diff and precise capture-limitation controls. Real HTTP/SSE/private-store web and Electron journeys live in `scripts/qa/session-changes.mjs`; this smaller fixture remains a presentation fixture.
