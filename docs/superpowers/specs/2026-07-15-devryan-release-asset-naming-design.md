# DevRyan Release Asset Naming Design

## Goal

Ensure every brand-bearing public release asset uses `DevRyan` without changing compatibility identifiers that existing installations and package consumers depend on. Tool-mandated neutral metadata filenames such as `latest-mac.yml` remain unchanged.

## Scope

- Stage the npm tarball as `DevRyan-web-<version>.tgz` before uploading it to GitHub Releases.
- Keep publishing the original package files to npm, the Visual Studio Marketplace, and Open VSX so their existing package identities remain stable.
- Rename manually produced macOS DMGs from the legacy `OpenChamber_*` prefix to `DevRyan_*`.
- Rename the published docs source archive from `openchamber-docs-source-*` to `DevRyan-docs-source-*` and align its deployment documentation.
- Update main release verification to require the DevRyan-prefixed npm tarball in addition to the existing desktop assets and reject any uploaded legacy-prefixed public asset.
- Rename the two legacy-prefixed assets already attached to release `v1.0.10`.
- Add a durable `AGENTS.md` rule that public release filenames must use `DevRyan`; compatibility names such as `@openchamber/web`, the `openchamber` CLI, extension IDs, protocols, and config paths remain unchanged unless a migration is explicitly requested.

## Design

Branding is enforced at the release boundary. Build tools may continue to emit filenames derived from compatibility package IDs. Workflows copy those files into a staging directory under deterministic `DevRyan` filenames, and GitHub Release uploads use only the staged copies. Marketplace and npm publication continue to consume the original outputs.


## Validation

- Run the release-asset verifier unit test.
- Run repository quick validation for the changed scripts and metadata.
- Inspect the canonical `1H-Team/DevRyan` release after renaming the existing assets.
- Confirm no user-owned working-tree changes are modified.

## Non-goals

- Modifying the legacy Tauri runtime beyond release filename branding in the existing manual build workflow.
