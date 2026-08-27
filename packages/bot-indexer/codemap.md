# Bot retrieval index codemap

`@openchamber/bot-indexer` is the disposable, Docker-local search projection
for encrypted canonical Bot memories, Library versions, and channel summaries.
Only the Electron-owned web host can reach it; reasoning containers cannot.

## Entry points

- `src/server.js` owns the authenticated host API, mutation serialization, and
  plaintext-to-chunk/embedding pipeline.
- `Dockerfile` bakes the exact Transformers.js model cache, its integrity
  manifest, and a CycloneDX SBOM into the non-root runtime image.

## Modules

- `chunker.js` — deterministic bounded Unicode-safe text chunking.
- `embeddings.js` — pinned offline MiniLM loading, cache verification, and
  canonical Float32 storage encoding.
- `index-store.js` — SQLite/FTS5 projection, versions, transactions, caps,
  corruption reset, and rebuild-required state.
- `search.js` — exact namespace validation, safe FTS queries, cosine ranking,
  and reciprocal-rank hybrid fusion.
- `server.js` — bearer-authenticated `status`, `upsert`, `delete`, `search`, and
  `rebuild` commands.

## Where to change things

- Change namespace grammar and hybrid ranking only in `search.js` with isolation
  tests.
- Change local retention/capacity and recovery semantics in `index-store.js`.
- Change model or cache integrity inputs in both `embeddings.js` and
  `scripts/prefetch-model.mjs`; the revision and ONNX digest must remain exact.
- Change host API shape and request limits in `server.js`.

Unit tests are colocated under `src`. `docker.test.js` is opt-in because it
builds the image and verifies volume deletion/rebuild behavior against Docker.
