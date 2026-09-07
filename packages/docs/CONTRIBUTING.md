# Docs Authoring Guide

This package is docs content source-of-truth for DevRyan.

## Add a new docs page

1. Create a new file in `packages/docs/content/docs/`.
   - Example: a new `remote-access.mdx` page in that directory
2. Add frontmatter at top:

   ```mdx
   ---
   title: Remote Access
   description: Access DevRyan from outside your local network.
   ---
   ```

3. Use route-safe naming:
   - `foo.mdx` -> `/foo/`
   - `folder/index.mdx` -> `/folder/`
   - `folder/bar.mdx` -> `/folder/bar/`
4. Run validation:

   ```bash
   bun run docs:validate
   ```

## Add a new sidebar section

Edit `packages/docs/sidebar.config.json`.

Example:

```json
{
  "label": "Advanced",
  "items": [{ "label": "Remote Access", "link": "/remote-access/" }]
}
```

Rules:

- use trailing slash in links (`/page/`)
- every sidebar link must map to an existing MDX file
- keep section labels short and task-oriented

## Package docs source

`.github/workflows/docs-source.yml` validates and packages this directory as a
`DevRyan-docs-source-*.tar.gz` artifact for release or manual distribution.
A website integration must be configured explicitly for the intended destination;
this repository does not authorize access to any upstream website checkout.

The repository validator also checks Markdown links and explicit source-file
references outside code examples. Historical audit reports and saved plans emit
warnings for missing old paths; generated build/runtime targets are reported as
unchecked. Current documentation must resolve its local references.
