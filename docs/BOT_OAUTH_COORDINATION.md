# Shared host and Bot OpenAI OAuth

Event `dac127cc-05d9-4dd8-938a-e3f89efbbbf6` remains unchanged. Its confirmed
immediate failure was `Token refresh failed: 401`; retained evidence cannot
establish the historical provider-side invalidation sequence. The repair
prevents host-login divergence, stale scoped writeback and independent managed
refresh owners. Provider revocation can still require reconnection.

## Ownership and safety

- The web/Electron server owns refresh and atomic persistence for `host:openai`.
  Refreshes coalesce; conversations and valid requests do not serialize.
- The packaged OpenCode config hook supplies a provider-specific HTTP transport.
  It retains built-in OAuth login methods, model selection, transformations,
  SSE streaming, cancellation, account headers and residency handling. It does
  not opt into experimental OpenCode WebSockets.
- Bots store connection references with a one-way account identity binding.
  No reusable refresh token goes into a per-run file. Successful refresh
  credentials are saved before access is released. Finishing Bot runs do not
  write these credentials back.
- Private runtime access is capability-bound and derived from server run
  claims. It is not a renderer API, agent tool, or caller-selected URL proxy.
  Image tools receive short-lived access through their existing private inode;
  tools cannot select a credential file or connection.
- Matching legacy accounts migrate in place; absent or mismatched account
  evidence requires explicit Manager reconnection. Existing IDs, revisions and
  audit records remain intact. Database binding commits before legacy vault
  cleanup; cleanup failure is explicit and retried on subsequent admission.
- `runtime/openai-oauth-state.json` contains only fingerprints, generations and
  refresh/block state. A rejected or uncertain exchange blocks its generation,
  including across crashes. A changed host login clears that state. Corrupt
  state or persistence failure fails closed; repair storage before restarting.
- No accepted prompt is replayed as part of authentication recovery.

## Scope

The integration coordinates managed web/Electron OpenCode and compatible Bot
images. External OpenCode processes and direct independent auth-file writers
remain outside the ownership contract. Do not concurrently refresh the same
login through an unmanaged process. API keys and unrelated providers retain
their execution behavior. UI auth mutations for the managed process share the
persistence queue because OpenCode writes the complete auth file.

## Rollout

1. Build and release the host/plugin and Bot OpenCode image together using the
   existing signed-image/release pipeline. Do not retag a production image in
   place. No database migration or Bot revision rewrite is needed.
2. Let active work finish before restarting the host or replacing warm
   runtimes. Old images lack protocol-1 authentication capability and shared
   OAuth admission fails with `bot_oauth_runtime_update_required`.
3. Ensure the managed host has initialized its provider plugin. Missing managed
   capability appears as `unavailable`; it must not fall back to snapshot auth.
4. Inspect Bot Settings credential `authState`. For `reauth_required`, reconnect
   the intended OpenAI account in Providers, then explicitly reconnect the Bot
   credential to `host:openai`. The endpoint requires Manager rights and the
   current `expectedUpdatedAt`; on conflict reload before choosing again.
5. Verify a new harmless run. Do not replay the failed accepted run, clear its
   audit event, or infer historical token contents from the new connection.

## Verification

Focused Vitest suites cover refresh coalescing, host login changes, late
completion, persistence failures, ambiguous exchanges, account migration,
reconnect races, private capability denial/revocation, warm adoption, image
credential preparation and exact authentication classification. Existing
dispatcher suites retain the accepted-prompt no-replay assertions.

Run the offline acceptance with an existing pinned OpenCode image:

```sh
node packages/bots-runtime/opencode/oauth.integration.mjs
```

`DEVRYAN_OAUTH_FIXTURE_IMAGE` can select another locally built image. The default
is `devryan/bot-opencode:dev`. The runner mounts current repository integration
files read-only, creates a disposable TLS CA, disables Docker networking, and
runs the pinned OpenCode and image dependency against loopback fixture services.
It removes its container and temporary files on completion. This does not
replace signed release-image verification or production rollout.

Set `DEVRYAN_OAUTH_FIXTURE_BAKED=1` with a freshly built image to test its baked
plugins instead of mounting the working-tree plugins. The acceptance verifies
the dependency versions before making fixture requests. Run it after other
large suites on resource-constrained Docker hosts.

Implementation verification (2026-08-31): 218 focused server tests passed;
affected validation passed (including 3,157 web tests); repository type checks
and lint passed. Offline OpenCode 1.18.25 acceptance completed six
chat/structured requests across a managed host and two Bot processes, one real
image-plugin request, and three coordinated refresh cycles. The check also
passed with the freshly built image's baked plugins. No production
login, Bot, failed run or audit event was changed.
