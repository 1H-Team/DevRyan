# Stage D Slim compatibility checkpoint

This note records completed compatibility seams and focused deterministic
evidence. Stage D assembly, compiled packaging, paid providers and actual browser
UI flows remain qualification work; these results do not establish their parity.

## Source and behavior ownership

The tracked Slim 2.2.25 original is
`packages/web/runtime/reviewed-inputs/slim-2.2.25/dist/server/index.js`.
`packages/web/server/lib/opencode/runtime-host/reviewed-package-transforms.js`
verifies the original hashes before
applying inventoried substitutions. Original command, interview, taskboard,
fallback, path, AST, image and webfetch algorithms remain the behavior source.
Finite filesystem, network, inference and continuation effects go through the
existing host owners. Build inputs do not become runtime `.cache` imports.

The configuration snapshot captures mutable selected configuration beneath
immutable reviewed registrations, with a coherent source stamp and shared
revision/digest. It preserves saved role/provider/model/variant and ordered
command/skill settings. Exact skill resource grants do not grant their parent
directories. Ponytail uses original instruction/command bytes and its scoped
mode owner. Executable registrations are independently reviewed and compiled.

`native-slim-runtime.ts` and `controller-slim.ts` execute the actual native setup
at active locations. Current hook authority contains the actual native permit,
event identity and AbortSignal, and expires when the hook settles. Sticky owner
errors survive original bridge catches. Native message transforms mutate the
existing array in place because the pinned session-context bridge subsequently
reads that array. Native attachments remain local references during taskboard RPC.

The existing scheduler owns taskboard state and prompt-observed terminal CAS;
this does not consume results. The existing primary controller owns fallback
reservation, recovery budgets and Stop/current-step fences. A recovery selection
is separate from the original objective's saved execution tuple.

Webfetch retains the original parser/extractor and invocation-local cache.
`controller-webfetch.ts` uses actual native SessionContext, history, request hooks
and LLMClient for secondary generation, under a private tool-derived permit.
It preserves the saved session model and drains actual work/progress after
cancellation. Original binary allocation uses bounded WX writes under an exact
owned temp root, with fresh checks and partial-file cleanup.

Interview context uses the original `createInterviewHostBridge`. Its actual
active-interview read receives hook cancellation; accepted command proof precedes
state-machine execution. The original service and UI handler run under existing
Node web, session and document owners. The raw original standalone listener and
dashboard auth-file manager are excluded. Command settlement is awaited after
an interrupted RPC. The original v2 bridge omits the service's optional model
argument when continuing; the current composition preserves that behavior.

## Focused evidence

| Check | Result and evidence |
| --- | --- |
| Original plus controller webfetch | 6 Bun tests passed, 45 expectations; `.cache/v2-validation/stage-d-controller-webfetch-final.log`. Actual local native secondary inference used the requested fallback model, retained the saved session selection, and exercised original HTML extraction, cancellation and scratch-file guards. |
| Actual Slim SDK and controller composition | 2 Bun tests passed, 86 expectations; `.cache/v2-validation/stage-d-controller-interview-signal.log`. Two active locations, an inactive location, catalog reload, Scope disposal, private command derivation and cancellation of a suspended actual active-interview RPC were checked. |
| Webfetch native type boundary | Passed; `.cache/v2-validation/stage-d-controller-webfetch-types.log`. |

The assembly review traced `controller-startup.ts`, `controller-interview.ts`
and `native-controller-interview.js` through original raw/mapped lifecycle events,
private accepted-command proof, canonical grants and settlement. The active-read
cancellation defect was corrected with the actual SDK regression above. No
additional concrete defect was established in that bounded review. Original
logger/location-disposal parity and complete assembled lifecycle/UI behavior
remain part of the broader Stage D gate, alongside compiled and live qualification.
