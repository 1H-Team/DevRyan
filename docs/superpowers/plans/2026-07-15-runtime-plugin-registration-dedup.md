# Runtime plugin registration deduplication implementation plan

1. Add a focused runtime-overlay regression for an active local plugin that shares a packaged filename, including packaged fallback restoration after the active entry disappears.
2. Run the focused test and confirm the generated overlay currently re-registers the local plugin.
3. Add the smallest plugin-spec classification and conditional packaged-registration logic in `runtime-agent-overlays.js`.
4. Update the OpenCode module documentation and codemap with the source-ownership rule.
5. Run focused tests, affected/full validation as warranted, and the production build.
6. Reproduce the real provider tool catalogs and visually verify the affected DevRyan workflow, then clean all disposable runtime artifacts.
