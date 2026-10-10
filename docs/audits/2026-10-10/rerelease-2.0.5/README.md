# DevRyanv2.0.5 replacement release

The user authorized replacing the existing GitHub v2.0.5 release, tag and release
commits, incorporating all current changes in one commit named `release v2.0.5`,
and publishing the rebuilt assets under the title `DevRyanv2.0.5`.

The candidate preserves the prior release changes and adds the
[model catalog repair](../model-catalog/README.md), including isolated startup,
same-version repaired-bundle delivery and controlled UI startup evidence. Earlier
publication evidence remains [historical](../release-2.0.5/README.md).

The distribution scope is `desktop-macos-arm64`, with exactly one public asset:
`DevRyan-2.0.5-arm64.dmg`. The production workflow retains signed Bot image,
anonymous-access, isolated topology, native preparation, packaged-runtime,
asset-digest and hosted migration gates. Hosted migrations are deployed and
verified before publication. No migration source differs from the previous
release; remote pending state is established by the publication workflow.

The [local qualification receipt](local-checks.json) records passing full
validation, production web/Electron build and bundle budgets. Full validation
includes workspace lint/types, documentation validation and all deterministic
package suites. The existing model-catalog audit supplies isolated packaged
startup and same-version repair-delivery evidence for these production changes.

Publication must pass the production [Release workflow](https://github.com/1H-Team/DevRyan/actions/workflows/release.yml).
Its `DevRyan-macos-arm64-packaging` artifact retains the immutable source,
version, asset name, size and SHA-256 receipt. Verify those fields against the
[published release](https://github.com/1H-Team/DevRyan/releases/tag/v2.0.5),
requiring the exact title, non-draft/latest state and single-asset allowlist.
Live inference, installed-app replacement, notarization and Windows acceptance
are outside this verification. Saved retired OpenAI logins require reconnection
before provider use. Existing v2.0.5 installations may require manual installation
because the replacement retains the same application version.
