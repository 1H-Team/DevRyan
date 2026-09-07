# Git rebase recovery visual fixture

Mounts the production rebase banner, sync buttons, and commit menu against a
paused linked-worktree scenario. Run `bunx vite --config tests/visual-git-rebase/vite.config.ts`
(port 4198). Verify disabled push/combined commit actions, reload recovery,
conflict resolution followed by Continue, Abort, and restored push controls.
The fixture simulates actions only; real Git behavior and HTTP errors are tested
in `packages/web/server/lib/git/operation-state.test.js`.


Verified on 2026-09-07 in the in-app browser and the repository's packaged
Electron visual shell: paused banner, disabled Push and combined commit actions,
available Refresh, Continue after resolving conflicts, recovery on reload, and
Abort returning to normal controls. These are the production shared components
with simulated actions, not a live repository mutation from the fixture.
