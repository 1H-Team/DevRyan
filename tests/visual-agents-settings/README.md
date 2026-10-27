# Agent settings visual fixture

Run `bunx vite --config tests/visual-agents-settings/vite.config.ts` from the repository root and open `http://127.0.0.1:4193`. Add `?theme=light` for light mode.

This fixture renders the real AgentsPage, Base UI selectors, and theme. Only the catalog, permission projection, tool list, and save boundary are isolated; it connects to no runtime or user profile. The initial Explorer model retains unsupported Medium. Select Low or Provider default and save to inspect the captured selection. Selecting Low and then Alternate model must retain Low with an error and disable Save until an explicit replacement is chosen.
