# Clean-user OpenCode setup design

## Goal

A full DevRyan installation must create a new user's OpenCode configuration from DevRyan's sanitized, versioned baseline. The baseline mirrors the repository owner's intended user setup without copying credentials, MCP configuration, generated state, or machine-specific data. Settings must show Slim setup controls only where they are relevant.

## Scope

The clean-user baseline includes:

- user-level OpenCode plugin registrations from the approved setup;
- the pinned `oh-my-opencode-slim` package, DevRyan Slim wrapper, and sanitized Slim configuration;
- the `opencode-with-claude` registration and the other approved plugin registrations;
- DevRyan agent definitions;
- approved user skills;
- safe OpenCode defaults such as disabled stock `explore` and `general` agents and LSP enablement.

The baseline excludes:

- every MCP definition and every Slim `mcps` field;
- credentials, tokens, secrets, authentication files, and environment files;
- logs, caches, backups, lockfiles copied from the source profile, and generated runtime overlays;
- absolute or otherwise machine-specific paths;
- `.DS_Store` and other operating-system metadata.

No dependency is added unless an existing installation mechanism cannot satisfy this contract.

## Baseline ownership

Sanitized source artifacts live under the existing `packages/web/server/default-config` ownership boundary. The repository, rather than a developer's live home directory, is the release source of truth.

A managed manifest records the version or content hashes of files installed by DevRyan. Provisioning follows the existing managed-file rule:

1. Write a missing managed file.
2. Update a managed file only when its current content still matches the previously installed managed hash.
3. Preserve a user-modified file and report a conflict.
4. Remove stale managed files only when they still match their last managed content.

Arbitrary user-owned files and configuration fields are not deleted.

## Provisioning lifecycle

One shared provisioning runtime owns clean-user setup for web/Electron.

On managed OpenCode startup it:

1. Resolves the actual user OpenCode configuration directory dynamically.
2. Detects a new or incomplete profile using deterministic file and manifest state.
3. Merges safe baseline configuration without removing unrelated user configuration.
4. Synchronizes managed agents, skills, and wrapper files using manifest hashes.
5. Ensures the required package dependencies are declared in the user configuration directory.
6. Runs the existing package-install mechanism in that directory when dependencies are missing or incorrect.
7. Produces explicit per-step results and conflicts.
8. Allows OpenCode startup to surface an actionable degraded state if package installation fails; failure is never presented as successful setup.

Provisioning must be idempotent. A second startup with no baseline changes performs no writes and no package installation.

External OpenCode mode does not mutate a remote host's filesystem. Provisioning applies only when DevRyan owns the local managed OpenCode runtime.

## Plugin configuration

The sanitized baseline registers the approved plugins from the owner's setup, including:

- `opencode-antigravity-auth@latest`;
- `@rama_nigg/open-cursor@latest`;
- `cursor-acp`;
- `opencode-with-claude`;
- `superpowers@git+https://github.com/obra/superpowers.git`;
- `./plugins/devryan-oh-my-opencode-slim.mjs`.

The Slim dependency remains pinned to the DevRyan-managed version. The Slim configuration preserves approved presets, agent model choices, variants, and skill choices, but contains no `mcps` fields.

Plugin registration does not imply authentication. Users still authenticate each provider through its normal flow, and no source-profile auth material is shipped.

## Settings behavior

The Slim status/action panel is not part of generic plugin details.

- A non-Slim plugin page renders only that plugin's read-only metadata.
- The Slim wrapper/raw Slim plugin page may render Slim runtime status and actions.
- A ready Slim setup does not show an `Install Slim` action; it shows ready state and an available repair action.
- A missing or incomplete Slim setup exposes installation or repair guidance from an appropriate Slim-specific surface.
- Status and mutations continue to refresh both Slim state and the plugin list.

## Error handling and safety

- Configuration writes are atomic where local precedent supports it and are backed up when mutating an existing user file.
- Package-install stderr and exit status are converted into actionable setup errors without logging secrets or environment contents.
- Partial installation results remain inspectable and repairable.
- A failed install does not strand an optimistic ready state.
- Provisioning never weakens runtime plugin allowlists or managed tool-surface policy.

## Cross-runtime behavior

The web server owns the shared implementation used by browser and Electron runtimes. VS Code uses the same baseline contract and equivalent manifest/merge semantics through its extension-host filesystem owner. UI contracts remain runtime-agnostic.

Tests must prove parity for the shared configuration inputs and expected clean-profile outputs even if filesystem adapters differ.

## Testing

Implementation follows test-driven development. Focused tests cover:

- a blank temporary home receives the complete sanitized baseline;
- no MCP configuration or Slim `mcps` field is installed;
- no auth, secret, cache, backup, generated, lockfile, or machine-specific artifact is copied;
- required package dependencies and plugin registrations are present;
- agents, skills, Slim config, and wrapper files are installed;
- a second run is a no-op;
- untouched managed files update when the baseline changes;
- user-modified managed files are preserved and reported as conflicts;
- unrelated existing user configuration survives merging;
- package-install failure is explicit and repairable;
- external OpenCode mode performs no local provisioning;
- generic plugin pages do not render Slim installation controls;
- the Slim page shows install only when setup is missing and repair when appropriate;
- web/Electron produce equivalent clean-profile state.

Validation includes the affected package tests, `bun run validate:affected`, and a build when packaging or bundled-resource paths change.

## Documentation

Implementation updates the root codemap only if entrypoints or ownership change. It updates `packages/web/server/default-config/codemap.md`, the OpenCode module documentation, the Plugins section codemap, documentation when their provisioning responsibilities change.
