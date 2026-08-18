# packages/web/server/lib/skills-catalog/

## Responsibility
Catalog/discovery/install pipeline for agent skills from curated Git sources and ClawdHub registries.

## Design
- **Barrel export API** (`index.js`) groups cache, source parsing, scanning, and install operations.
- **Pluggable source model**: generic repository scanner/installer plus dedicated `clawdhub/` provider implementation.
- **Caching layer** reduces repeated remote scans for identical source/query tuples.
- **Safe archive boundary**: ClawdHub download/install delegates to `@openchamber/shared-runtime`; host code supplies rate-limited transport and target policy only.

## Flow
1. Caller resolves source string via `parseSkillRepoSource` or ClawdHub IDs.
2. Scan path fetches metadata/manifests and normalizes skill entries.
3. Install path downloads/clones skill content. ClawdHub ZIPs are bounded, preflighted, staged, audited, and transactionally committed before the configured target changes.
4. Cache stores/retrieves scan outputs to speed repeated requests.

## Integration
- Consumed by OpenCode skill management routes/runtime.
- Depends on git/network utilities, filesystem writes, and the shared safe-archive runtime.
- Integrates external registries: GitHub-like repos and ClawdHub API/download endpoints.
