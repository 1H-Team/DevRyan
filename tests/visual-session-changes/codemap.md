# Session changes visual fixture

Mounts the production session changes card and revision diff dialog against
synthetic session A/B results. No provider, user runtime, or credentials are used.
Run `bunx vite --config tests/visual-session-changes/vite.config.ts` (port 4196).
Check expanding rows, recorded diff, Undo confirmation/Redo, independent session
switches, incomplete coverage, empty loading/failure/partial summaries, Retry,
and narrow layouts. The structural-update counter verifies the card notifies
its scroll owner when its contents change. This verifies presentation;
the harness and host tests verify actual Git capture and restore behavior.
