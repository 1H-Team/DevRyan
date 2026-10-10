# Native startup catalog diagnostics

## Provider request and account boundaries

The [primary SIWC transport incident](../../../../../../docs/audits/2026-10-10/siwc-primary-transport/README.md)
records the transport mismatch, synthetic reproduction and verification
status.

`controller-providers.ts` removes the prepared WebSocket option when the OpenAI
credential owner reports a current ChatGPT SIWC selection. This policy applies
to all native request kinds; API-key requests retain their prepared transport.
Credential values stay in `native-openai.ts`, and physical hooks still enforce
account identity and route restrictions. `native-observation.ts` records bounded
`provider-refusal` observations for physical OpenAI hooks using only reviewed
codes, request kind and hook name alongside the common session identity.

The shared SIWC response adapter accepts SSE keepalives and split frames, and
accepts the observed direct-route response with an omitted Content-Type header
while validating its framing and normalizing the downstream SSE header. It finishes at `response.completed` without waiting for EOF. Structured terminal
provider failures reach the native parser intact. A cancelled consumer cancels
the underlying response; premature EOF and malformed or oversized frames still
fail. API-key requests bypass this SIWC normalization.

Provider credential resolution reads its selected snapshot inside the serialized
mutation queue. Concurrent requests may advance only through a refresh committed
by that same controller while their resolutions are pending. Account switches,
revoked authorization and unrelated credential replacement still fail. Session
correlation includes the credential request's binding, allowing title and primary
request resolution to be traced independently.

Claude inspection uses the implicit default account when there are no saved
profiles, the sole profile when there is one, and the exact configured default
when there are several. An ambiguous selection stays unavailable. Ordinary
shared credentials are read from their original owner without renewal or writes;
expired shared credentials require reconnecting through Claude Code/Meridian.
Dedicated enrollment is optional automatic renewal.

## Startup diagnostics

The native controller composes the actual location graphs in `bootstrap.ts`.
`startup-catalog.ts` reads their agent, plugin and model HTTP catalogs after the
plugin activation barrier. Model availability remains a separate per-selection
result; unavailable saved models do not block intrinsic startup readiness.

The native owner verifies each launch after prior-controller settlement, then
runs the lifecycle's `beforeConfiguration` callback to synchronize managed
configuration before capturing its snapshot. The lifecycle does not repeat the
same full bundle scan. Boot's fresh bundle verification also carries its checked
artifacts privately to the loader, pinned to the exact selected manifest,
controller, writer and supervisor. This receipt is not serialized. Executable
configuration is still checked and imported from its exact validated bytes;
the independent artifact verification immediately before controller spawn and
all restart/checkpoint verification remain in place.

`native-catalog-diagnostics.ts` classifies known host refusals, construction and
model stages, and schema failures. HTTP response-body schema failures use
`response_schema_invalid`, including the SDK's `InvalidRequestError` with
`kind: Body`. A failed model HTTP read therefore reports
`native_catalog_read_failed_model_http_<status>_response_schema_invalid`.
Arbitrary errors retain `cause_unavailable`; response text is never used to
infer a cause.

Retired OpenAI OAuth methods (`chatgpt-browser`, `chatgpt-headless`, and
`chatgpt-token-sharing`) resolve as unavailable catalog connections. Their
presence cannot prevent startup, refresh a credential or rewrite the database.
Physical requests still refuse unsupported authentication before acquiring
access. Other unsupported methods retain `openai_method_unsupported` in catalog
diagnostics. The cold graph regression starts with a synthetic retired login
and NULL connector/method columns and requires model HTTP 200 in both locations.

Provider usage reads: `provider-read-selected-owned` (protocol allowlist
`directory`, `controllerInstanceID`, `integrationID`) is a read-only owned
action limited to `xai` and `opencode-go`; the protocol parser rejects every
other integration. The controller refuses a foreign controller instance or an
unreviewed directory, returns nothing when no credential connection is active,
requires xAI `oauth`/`device` with an access token or an OpenCode Go key, and
refuses `native_credential_changed` if the active credential changes during the
read. It never refreshes, writes or logs the value, and an xAI reply carries only
the access token and its expiry — the refresh grant never leaves the controller.
The host owner exposes it as
`readProviderSelected` under a `provider.integration` caller grant, and the
reply's instance, directory and integration are verified. Credential metadata
validation accepts OAuth rows only for OpenAI `chatgpt-*` methods and xAI
`device`; other providers must be keys.

SDK endpoints can retain their construction error reporter. An asynchronous
request scope routes its reports to the active catalog assertion, without
mixing concurrent requests or retaining a previous request's failure. Cause
chains are bounded and cycle checked. Native schema issue trees, or the SDK's
converted formatter path lines, yield at most eight paths of 256 characters.
Only enumerated native field names and numeric indices survive; dynamic record
keys become `<key>`. Input values, reason text, stacks and configuration are
never recorded by this producer.

`native-provider-compat.js` validates each model against the encoded `Model.Info`
schema and checks JSON serialization before policy normalization and after
provider discovery. The compatibility service excludes unencodable rows from
catalog reads and records `model_response_schema_invalid` with a model index
and safe field path. Healthy model references and unchanged arrays survive.
The source config and database are not rewritten. This guard may remove a
saved model from the picker; it does not establish that an installed incident
was caused by an invalid model.

`native-process.js` retains at most 4 KiB of controller stderr in memory. Raw
stderr is never written to its lifecycle log or journal. After owned termination
on startup failure, only sanitized recognized logfmt fields (`level`, fixed
`msg`, enumerated `name`/`_tag`, whitelisted `schemaPath`) attach to the startup
error. Successful binding also exposes these bounded diagnostics. The runtime
owner includes them in the `native_startup` failed/bound journal record. The
existing observation-gap marker remains deduplicated across stderr chunks.
The harness sanitizer validates these fields again and preserves exact fixed
catalog codes through journaling and export without the high-entropy heuristic
redacting them. Unrecognized plugin text cannot become journal evidence.

The isolated `startup-catalog-reproduction.mjs` runner captures Cursor model
IDs, prices and variant structures and optional Anthropic credential presence.
Endpoints and credentials become synthetic loopback fixture values. Its
`--legacy-oauth-columns` switch clears legacy connector/method columns only in
the fixture's synthetic credential rows. `--output-root` is confined to repository
`.cache/sessions/` and retains the sanitized input documents. The host and
selection-view subprocesses run under Node even when the CLI runs under Bun;
the compiled native controller remains the supplied verified artifact.

See [runtime verification](../../../../../../docs/AGENT_RUNTIME_VERIFICATION.md)
and the [2026-10-10 incident audit](../../../../../../docs/audits/2026-10-10/model-catalog/README.md)
for isolation rules and the limits of the reproduced evidence.

### Startup timing

The web entry logs `bundle_preparation` and `application_import` before the
journal owner exists. Native launch logs consecutive `native_settlement`,
`native_verification`, `native_configuration_sync`, `native_configuration`,
`native_controller`, `native_recovery`, and `native_open` durations through
`../startup-timing.js`. These records contain fixed phase names, monotonic
elapsed milliseconds and completion/failure outcomes only. Existing journal
startup/failure records and recovery ordering remain authoritative. The timings
are observations, never readiness or integrity shortcuts.

Startup binding reads sealed bundle documents with the same 32 MiB
`BUNDLE_DOCUMENT_MAX_BYTES` limit used by bundle storage and native boot
verification, checking both file metadata and bytes read. Hash, canonical-path
and symlink checks remain required. Electron's startup failure page falls back
to its default appearance if selected-bundle settings cannot be read, preserving
the original error and Retry action even after an upgrade changes selection.
The [runtime preparation audit](../../../../../../docs/audits/2026-10-10/runtime-preparation/README.md)
records the incident and isolated packaged regression evidence.
