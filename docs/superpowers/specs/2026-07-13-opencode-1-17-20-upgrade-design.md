# OpenCode 1.17.20 Upgrade Design

## Goal

Update DevRyan's supported OpenCode baseline from 1.17.19 to the latest stable release, 1.17.20, while keeping the external runtime recommendation and the shared SDK dependency aligned.

## Scope

- Update every workspace declaration of `@opencode-ai/sdk` from `^1.17.19` to `^1.17.20`.
- Regenerate `bun.lock` so the resolved SDK is 1.17.20.
- Update the web and VS Code target-runtime policy constants to 1.17.20.
- Update version-policy tests and module documentation that describe the supported OpenCode baseline.
- Update version-specific compatibility prose only where it refers to the supported baseline rather than a historical behavior that remains tied to 1.17.19.

No OpenCode API refactor or unrelated dependency update is in scope. If validation exposes an SDK contract change, the minimum compatibility fix may be added after its impact is understood; otherwise the change remains version-only.

## Dependency Policy

Keep the repository's existing caret ranges. The manifests will declare `^1.17.20`, preserving current patch/minor resolution behavior instead of introducing an exact-pin policy as part of this upgrade.

The externally installed OpenCode runtime remains a recommendation and diagnostic target. DevRyan continues to respect explicit user and environment binary choices.

## Verification

Because the SDK is shared across UI, web, and VS Code and the runtime target is a cross-runtime contract, run:

- Focused version-policy tests for web and VS Code.
- `bun run validate:full`.
- `bun run build`.

Any failure caused by the user's existing unrelated working-tree changes will be reported separately from failures caused by the OpenCode upgrade.

## Change Safety

Preserve all pre-existing working-tree edits. Stage and commit only this design document during the design phase; implementation changes remain separate.
