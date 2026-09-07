# DevRyan Docs Source

This package is the source-of-truth for DevRyan public docs content.

## Layout

- `content/docs/*.mdx` - English docs pages
- `sidebar.config.json` - docs navigation structure for Starlight sidebar
- `CONTRIBUTING.md` - authoring guide for adding pages and sections
- `DEPLOYMENT.md` - release/manual packaging and sync trigger model

## Local validation

Run from repo root:

```bash
bun run docs:validate
```

This validates:

- frontmatter (`title`, `description`) exists for every MDX page
- sidebar links resolve to existing MDX routes
- repository Markdown local links and explicit source-file references resolve (historical and generated targets are reported separately)

## Deployment model

This repo owns docs content.

Website rendering and deployment are separate from this source repository. An optional destination must be configured explicitly; see [DEPLOYMENT.md](DEPLOYMENT.md).

Use `.github/workflows/docs-source.yml` to package docs source on release or manual trigger.
