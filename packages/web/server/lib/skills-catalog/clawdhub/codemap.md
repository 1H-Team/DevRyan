# packages/web/server/lib/skills-catalog/clawdhub/

## Responsibility
ClawdHub adapter for the skills catalog: browse registry entries, resolve versions, download ZIP packages, and install into user/project skill roots.

## Design
- `api.js` encapsulates HTTP concerns (cursor pagination, retry/backoff for 429/5xx, download endpoint).
- `scan.js` maps ClawdHub payloads to internal `SkillsCatalogItem` shape and supports full or page scans.
- `install.js` enforces name validation, conflict policy, temp extraction validation (`SKILL.md`), and atomic placement.
- `index.js` exposes a small boundary (`scan`, `install`, source guards/constants).

## Flow
1. Catalog flow calls `scanClawdHub*` to fetch and normalize registry items.
2. Install flow builds plans from selected slugs/versions.
3. Each plan resolves target path by scope/source, handles overwrite/skip policy, downloads/extracts, and moves into final skill dir.
4. Result reports installed/skipped entries with machine-readable reasons.

## Integration
- Used by `skills-catalog` runtime as one source implementation alongside git/local sources.
- Writes into project `.agents/skills/` or `.opencode/skills/` directories according to the selected source, or the corresponding user-level config skill directories.
