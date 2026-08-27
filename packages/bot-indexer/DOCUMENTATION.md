# Local rebuildable Production Bot retrieval

See `docs/BOTS_RUNTIME.md` for setup, repair, data-location, and recovery
guidance. This index remains a disposable local projection.

The index is a disposable local projection, never a source of truth. Supabase
keeps encrypted canonical memory, Library, and channel-summary versions. The
web host decrypts only records the current principal/run is authorized to use
and sends them to this service for a deterministic rebuild or versioned update.
No plaintext chunk or embedding is uploaded back to Supabase.

## Isolation contract

The only accepted namespaces are exact values:

- `bot:<botId>` for reviewed shared Bot memory and Library material;
- `bot:<botId>:user:<userId>` for that user's private memory;
- `channel:<channelId>` for channel-only summaries and private material.

There is no prefix or wildcard lookup. The web server constructs the exact
authorized list and injects bounded retrieved text into the scoped OpenCode
run. Reasoning containers are not attached to the management network and never
receive the indexer bearer token. Compose publishes the service only on an
ephemeral `127.0.0.1` host port through a no-masquerade control bridge; the
container has no outbound NAT.

## Storage and recovery

SQLite stores documents, normalized chunks, Float32 embeddings, and an FTS5
projection solely in `/var/lib/devryan-bot-index`. The store uses built-in
`node:sqlite` when that Node build includes FTS5 and otherwise the pinned
`better-sqlite3` 12.11.1 binding baked for the image. It enforces document,
chunk, metadata, and aggregate-byte limits transactionally. An empty or deleted
volume reports `rebuild_required`; search fails closed until a successful
atomic rebuild. A malformed SQLite file is deleted as disposable plaintext and
recreated in the same state with reason `corrupt_index_recovered`.

Upsert and delete bind an exact canonical version. Reusing a version with
different content or deleting a different version returns a stable conflict,
which prevents stale work from rewriting the projection.

## Offline embeddings and image evidence

The image pins `@xenova/transformers` 2.17.2 and
`Xenova/all-MiniLM-L6-v2` revision
`08a308f628bc9d6774b7922f319eb1b65afa1a82`, including the quantized ONNX
SHA-256. Build downloads the model once, hashes every cached file, and writes
`/opt/devryan/model-cache-manifest.json` plus `/opt/devryan/sbom.cdx.json`.
Startup verifies every cached file before loading with remote models disabled.

Run `npm test` in this package for unit coverage. Set
`DEVRYAN_RUN_BOT_INDEXER_DOCKER_TESTS=1` to build the image and test namespace
isolation, restart persistence, and the required rebuild state after volume
deletion.
