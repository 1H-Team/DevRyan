# Docs Source Deployment

This repo publishes docs **source artifacts**.

Rendering and hosting are owned by a separately configured website.

## Workflow

Use `.github/workflows/docs-source.yml`.

Triggers:

- push to `main` when docs source changes
- release published
- manual `workflow_dispatch`

Outputs:

- validates docs (`bun run docs:validate`)
- creates `DevRyan-docs-source-<sha>.tar.gz`
- uploads archive as workflow artifact
- on release/manual with tag, uploads archive to release assets

## Optional cross-repo sync trigger

The workflow can trigger a `repository_dispatch` event in an explicitly configured destination. No upstream destination is selected by default.

Configure this repository:

- `DEVRYAN_DOCS_WEBSITE_REPO` repository variable (`owner/repository`).
- `OPENCHAMBER_WEBSITE_REPO_TOKEN` secret with access to that destination (compatibility secret name).

Event sent:

- `event_type: docs_source_updated`

Payload includes:

- `source_repo`
- `source_ref`
- `archive_name`

The configured website can listen for this event and pull docs source from release artifacts.
