# Helper cold scope and focused V2 contract regressions

14 October 2026. The full compiled package attempt stopped before its model-title
gate. After repairing the fixture's masked rejection, the actual refusal was
`native_helper_location_expired`. The first source regression repaired cold graph
activation, but a fresh compiled attempt still refused. Adding the actual shipped
observation/stream overrides to that regression reproduced the refusal at the
ready helper: LayerNode's last-wins stream replacement discarded the independent
helper LLM capture. The constructor now composes the scoped helper capture inside
the real stream wrapper. The combined source graph passes cold inference and the
held-finalizer ACK probe. Both compiled attempts remain failed prerequisites;
neither is a runtime pass.

The helper now acquires the original `LocationServiceMap` graph for the admitted
directory, awaits real plugin activation, and runs inference in one Effect scope
held through native finalizers. It creates no SessionStore record. The admission
deadline, selected model/configuration, permit and cancellation checks remain. A
real held native finalizer regression confirms the production helper route emits
one settlement ACK only after that finalizer releases, with the original abort
reason.

Sampling mapping is qualified only for the native OpenAI-compatible chat package.
Captured finite agent `temperature` and `top_p` defaults become native generation
options; explicit sampling disablement, earlier hook choices, absent defaults and
unknown body fields are preserved. Other provider packages remain unqualified;
GPT high-effort requests retain sampling omission. Actual compatible-chat requests
prove zero temperature and top-p 0.37.

Focused checks completed:

- Bundled controller webfetch graph: 1 passed, including genuinely cold helper,
  actual shipped observation/stream plus helper capture composition,
  zero persisted conversations, supported physical sampling, omitted defaults,
  unsupported capability, invalid typed sampling, unrelated body-field exclusion,
  earlier hook options, concurrent private helper IDs, empty tools, and held ACK.
- Provider middleware/instruction graphs, native checkpoint history, reviewed
  skill ownership and native grandchild queue graph: 10 passed.
- Helper fixture early rejection and reviewed setup contracts: 6 passed.
- Actual native Continue source graph with the same helper capture composed in
  the stream owner: 1 passed. Existing stream scenarios now use this composition.
- Web and runtime-host TypeScript checks passed; docs validation and diff check passed.

Commands use repository-installed Bun/Node and TypeScript only:

```text
bun test scripts/opencode-v2-native/controller-webfetch.test.ts
bun test scripts/opencode-v2-native/native-stream-continuation.graph.test.ts --test-name-pattern '^pinned 2.0.26 native stream graph continue Slim=false compiled=false$'
bun test packages/web/server/lib/opencode/runtime-host/native-queued-input.test.ts scripts/opencode-v2-native/native-compaction-checkpoint.graph.test.ts scripts/opencode-v2-native/reviewed-skill-execution.test.ts scripts/opencode-v2-native/controller-providers.graph.test.ts
node --test scripts/opencode-v2-native/package-helper-isolation-lane.test.mjs scripts/opencode-v2-native/reviewed-setup.test.mjs
./packages/web/node_modules/.bin/tsc -p packages/web/server/lib/opencode/runtime-host/tsconfig.json --noEmit
```

The checkpoint test uses the pinned native projector, database and history owner;
it proves provider/model/endpoint replay fencing and original transcript recovery,
not a physical compaction call. The compiled helper lane now requires actual
sampling bytes too. A rebuilt production artifact and full compiled package
qualification, including model-title → persist once → restart restore, remain
required before a shipping claim. No upstream checkout, dependency change or
publication occurred. Cache report and pruning preview completed; unrelated
cache entries were retained.

Independent integrated owner review reproduced two defects despite green unit
tests: a queued task's durable admission was reported as a refusal when its later
starting save failed, and canonical Plan validation expected a numeric successor
attempt while the native receipt owns a `{traceID, spanID}` witness. Root owns the
corrections and full qualification. The committed-submission correction passed
an independent rerun of its 3 owning regressions, including a held running-save
that keeps the returned submission at the last committed starting state.
The other reviewed owner suites
passed 45 web tests, 24 scheduler/recovery/store tests, and 6 direct-finish tests.
This review does not claim a full compiled shipping result.

The final deterministic HTTP replay regression connects the real provider route,
v2 facade and admission owner to the title runtime, in-memory candidate outbox,
native accepted-input verifier and constructor latest-human witness. Canonical
fixture users carry fingerprints built by the production admission recipe. One
generated candidate exhausts three persistence attempts for A; canonical B can
reopen one three-attempt cycle. Replaying A → B → A afterward retains the paused
candidate, B identity and attempt count, with six persistence calls total and one
model generation. A newer D arriving while C's final native reauthorization is
held also leaves that paused cycle unchanged. Native transport calls are only
canonical GET reads; this test does not run a provider or native process.

The connected test first exposed a dropped UI origin header: canonical human
fingerprints received a 409 replay conflict because the browser facade supplied
unknown origin. The facade now carries only the exact `human` marker on prompt
requests. Six owning real-admission cases prove that absent, malformed, duplicate
array, managed-primary and native markers stay unknown. Principal and native
authorizers and constructor-only canonical metadata remain unchanged.

The final owning group passed 155 tests across provider routes, facade routes and
the public-client privilege contracts. Documentation validation and diff checks
passed. Source edits for this correction are limited to the facade, its tests,
the provider-route regression and these contract documents.

```text
bun run --cwd packages/web vitest run server/lib/opencode/provider-routes.test.js server/lib/opencode/v2/facade-routes.test.js server/lib/opencode/opencode-client/opencode-client.contract.test.js --no-file-parallelism --maxWorkers=1
bun run docs:validate
git diff --check
```
