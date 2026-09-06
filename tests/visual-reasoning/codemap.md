# Reasoning presentation verification

`main.tsx` mounts the production reasoning group, Markdown renderer, collapsible,
locale provider, UI store, and narrow active-status subscription. Provider
parts and lifecycle transitions are synthetic; `directory-context.ts` supplies
an unselected directory so Markdown does not start the app sync owner. No
provider or user runtime is contacted. Fixture stage persistence checks canonical history
reloading. Expansion remains component state, matching a fresh mounted history.

Run `node tests/visual-reasoning/run.mjs` from the repository root after installing
the repository's existing dependencies. It starts Vite on an ephemeral loopback
port and the installed Electron Chromium shell with its own browser profile.
The runner reuses `scripts/qa/cdp.mjs` and `process.mjs`, stops only its owned
resources, and writes source hashes, checks, screenshots, sanitized logs, and
cleanup status to `.cache/qa/reasoning-*/result.json`.

For manual interaction use `bunx vite --config tests/visual-reasoning/vite.config.ts`
and open the reported URL. The fixture exposes `window.__reasoningFixture` for
deterministic `setStage`, `setMode`, and `setTheme` transitions. Navigation controls
perform the same stage changes; disclosure activation is the real component's
pointer/keyboard handling.

The runner checks empty/whitespace pending status, delayed first text without
focus theft, Enter/Space and pointer activation, appended-part ordering, ended
part gaps, cancellation/completion focus and expansion retention, lazy collapsed
content, ownership release, and reload. It captures expanded content at 390×844,
844×390, and 768×1024 in both themes. Review captured images before marking visual
acceptance. This fixture is component acceptance, not provider or full-host QA.
