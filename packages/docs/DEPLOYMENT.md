# Docs Source Deployment

This repo owns docs **source** only. Rendering and hosting belong to a separately configured website; none is configured, and this repository does not authorize access to any upstream website checkout.

CI (`.github/workflows/ci.yml`) validates this directory on every push to `main` with `bun run docs:validate`. To hand the source to a website, archive `packages/docs` from the commit you want, for example:

```bash
git archive --format=tar.gz -o DevRyan-docs-source.tar.gz HEAD packages/docs
```
