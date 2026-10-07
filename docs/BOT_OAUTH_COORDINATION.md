# Shared host and Bot OpenAI OAuth

Event `dac127cc-05d9-4dd8-938a-e3f89efbbbf6` remains unchanged. Its confirmed
immediate failure was `Token refresh failed: 401`; retained evidence cannot
establish the historical provider-side invalidation sequence. The repair
prevents host-login divergence, stale scoped writeback and independent managed
refresh owners. Provider revocation can still require reconnection.

## Ownership and safety

- The web/Electron server owns refresh and atomic persistence for `host:openai`.
  Refreshes coalesce; conversations and valid requests do not serialize.
- ChatGPT subscription auth is **Sign in with ChatGPT** (OSS plan usage): DevRyan
  owns local-only enrollment (`/api/provider/openai/siwc`); status and mutations
  require direct loopback administrator transport without forwarding headers,
  and mutations also require CSRF. Begin-owned five-minute deadlines reclaim
  abandoned callback listeners. Saved sign-in survives catalog failures, with
  bounded model-discovery retry; active staged registrations expose recovery.
  The host stores issued `client_id` with
  tokens in the selected native credential, and refreshes at
  `https://auth.openai.com/api/accounts/oauth/token`. The host registration cache
  retains only an opaque reference, verified subject, issued client, host ID and
  native credential references. A missing plan-use scope keeps the user signed
  in while disabling plan requests. Legacy Codex browser/headless OAuth remains
  identifiable and requires reconnection through SIWC.
- The packaged OpenCode config hook supplies a provider-specific HTTP transport.
  SIWC inference uses `https://api.openai.com/v1/responses` with a bearer access
  token only (no Codex `chatgpt.com` rewrite). Built-in API-key login remains.
  The transport does not opt into experimental OpenCode WebSockets for plan usage.
- Bots store connection references with one-way account and issued-registration
  identity bindings. Two clients issued for the same subject stay distinct.
  No reusable refresh token goes into a per-run file. Successful refresh
  credentials are saved before access is released. Finishing Bot runs do not
  write these credentials back.
- Private runtime access is capability-bound and derived from server run
  claims. It is not a renderer API, agent tool, or caller-selected URL proxy.
  SIWC accepts only POST Responses inference and GET account model discovery.
  Image generation, Chat Completions and other endpoints are refused at their
  physical request boundaries. API-key image behavior remains independent.
  Native images read only the selected OpenAI API key under the admitted tool
  lease, compare the exact native credential through request and publication,
  and use public Responses without a ChatGPT account header. Image output
  reports API-key billing. Expired SIWC credentials refuse before refresh;
  original Codex parser fixtures remain separate from production auth acceptance.
- Matching legacy accounts with issued-client identity proof migrate in place; absent or mismatched account
  evidence requires explicit Manager reconnection. Existing IDs, revisions and
  audit records remain intact. Database binding commits before legacy vault
  cleanup; cleanup failure is explicit and retried on subsequent admission.
- `runtime/openai-oauth-state.json` contains only fingerprints, generations and
  refresh/block state. A rejected or uncertain exchange blocks its generation,
  including across crashes. A changed host login clears that state. Corrupt
  state or persistence failure fails closed; repair storage before restarting.
- No accepted prompt is replayed as part of authentication recovery.

- Returning enrollment resolves an opaque registration reference server-side,
  reuses its issued client and verifies JWT issuer, audience, signature, expiry,
  nonce and subject before saving. Enrollment publishes its registration and
  exact SDK-supported credential ID before requesting inactive creation, then
  activates under selected-credential comparison. A failed initial publication
  creates no credential; a lost create receipt retains the exact recovery target.
  The SDK automatically selects its first credential; only that
  exact newly saved record may replace the captured empty-selection fingerprint,
  after native identity and row verification. Later failures retain its recovery
  reference. Reconnect can finalize an already-active staged record through the
  existing selection path with native row, selection and caller checks.
  Cancellation removes only its exact inactive stage; publication failures retain
  a recovery reference. Browser requests cannot provide issuer/client/token data.
- Models come from the currently selected native credential and account endpoint.
  Account order and display names are preserved. Lookup failure is unavailable;
  runtime-missing slugs remain visible as unsupported. A late account response
  cannot change the catalog after selection moves.
- Sign-out blocks the selected credential, drains helpers and native session
  owners, attempts discovered remote revocation with bounded retry, then removes
  exactly the compared local credential. It reports remote confirmation and local
  cleanup separately. Local failure leaves the credential blocked. Issued
  registration and host identity survive for reconnection.

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

Focused Vitest suites cover signed enrollment and refreshed identity checks,
registration selection/cancellation/recovery, native catalog ownership and order,
remote versus local sign-out outcomes, refresh coalescing, host login changes, late
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

The OpenCode 2.0.24 offline lane uses a synthetic registered SIWC grant, the
official refresh resource and Responses projection. It covers three coordinated
refresh cycles, ordinary and structured requests, attachments, cancellation,
restart and host events with the internet disabled. SIWC image generation is
refused before provider dispatch or file publication; API-key image behavior
belongs to the compiled reviewed-package qualification.

Historical pre-SIWC verification (2026-08-31): 218 focused server tests passed;
affected validation passed (including 3,157 web tests); repository type checks
and lint passed. Offline OpenCode 1.18.25 acceptance completed six
chat/structured requests across a managed host and two Bot processes, one real
image-plugin request, and three coordinated refresh cycles. These historical
Codex/image results are not SIWC production or release evidence. The check also
passed with the freshly built image's baked plugins. No production
login, Bot, failed run or audit event was changed.
