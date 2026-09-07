# Managed dispatch visual fixture

`main.tsx` mounts the production managed dispatch list and rows against fixture task events. `fixture-sync.ts` isolates title subscriptions and resync from runtime/provider state. It exposes immediate/delayed title arrival and rename controls; the sidebar preview uses the shared title resolver. Skill activity and implementation prose are simulated transcript entries, while startup admission is verified in the bundled plugin contract tests.

Run `bunx vite --config tests/visual-managed-dispatch/vite.config.ts`, then open port 4191. Verify desktop/mobile: the card is absent during title loading, appears after the statement when the canonical title arrives, and follows renames. No credentials or installed-app state are used.

Verified on 2026-09-07 in the in-app browser at desktop size and 390 × 844: hidden placeholder card, delayed title reveal below implementation prose, matching shared sidebar/card title, and rename without duplication. Skill activity is simulated; these visual checks do not establish live provider compliance.
