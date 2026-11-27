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

CI (`.github/workflows/ci.yml`) validates this directory with `bun run docs:validate`;
see [DEPLOYMENT.md](DEPLOYMENT.md) for handing the source to a website.
A website integration must be configured explicitly for the intended destination;
this repository does not authorize access to any upstream website checkout.

The repository validator also checks Markdown links and explicit source-file
references outside code examples. The changelog emits warnings for missing old
paths; generated build/runtime targets are reported as unchecked. Current
documentation must resolve its local references.

It also checks documentation against the code (`scripts/docs/`): link anchors
resolve to a heading by GitHub's slug rules, every `bun run <name>` names a
script of the root manifest or of the `--cwd`/`--filter` package, each
`` `name(` `` under a heading such as `## Public exports (file.js)` occurs in
that file, and every `DEVRYAN_*`, `OPENCHAMBER_*` or `OPENCODE_*` token occurs
in non-Markdown code. Known drift is listed in `scripts/docs/known-drift.json`,
which only shrinks: new drift fails, and so does an entry that no longer occurs
until it is deleted (`bun run docs:validate --prune` deletes exactly those).

The other direction is checked too (`scripts/docs/env-readers.mjs`): every
`DEVRYAN_*` (or its `OPENCHAMBER_*` alias) and `OPENCODE_*` variable that
production code under `packages/` reads or sets (not tests, fixtures, the legacy
`packages/desktop`, or build and development scripts) must be named in full in
some current document; a family name such as `DEVRYAN_LEDGER_*` does not count.
Comments are ignored. Besides direct reads (`env.X`, `env['X']`, destructuring,
helpers and native `getenv`), it follows same-file constants, lists or maps of
names read through a computed key, shell text in strings (`$X`), and, for
`DEVRYAN_`/`OPENCHAMBER_` names, any string literal that is exactly such a name.
A literal of that shape that is not a variable (an error code) goes in
`NOT_ENVIRONMENT_LITERALS` in that file, with its reason. It does not see names
assembled at run time or another file's constants of other prefixes. The failure
names the variable and the file and line that reads it, and says to describe it
in [`docs/ENVIRONMENT.md`](../../docs/ENVIRONMENT.md) or the package document
that owns it. Its baseline, `scripts/docs/known-undocumented-env.json`, holds
`{ name, reason }` entries and only shrinks the same way.
