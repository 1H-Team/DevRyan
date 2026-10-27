# Answers to the Phase 2 open questions F1–F7, F9, F11 and F12

Facts observed on OpenCode 2.0.20, captured as described in [README.md](README.md): the G1 embedded host with the simulation backend. Each answer cites the vector file and the `rest[].label` or `notes` key that shows it. Ids and times are the normalised values in those files. Statements about dist source give the file under `.cache/v2-spike/node_modules/@opencode/`.

## F1: Do ephemeral deltas reach the wire before the durable `*.started` events?

**Not observed: 0 of 51 turns.**

- **Counts.** `f1-frame-order.json` `notes.stats` covers 50 one-step turns, each with 2 reasoning deltas and 2 text deltas in one provider chunk. Every count is 0: `textDeltaBeforeTextStarted`, `reasoningDeltaBeforeReasoningStarted`, `deltaBeforeStepStarted` and `textEndedBeforeLastTextDelta`. `notes.perTurnTypes` gives each turn's frame order.
- **Spaced deltas.** In `01-two-step-tool-turn.json` the provider chunks were spaced 150 ms apart, and the order still held: `step.started`, `reasoning.started`, `reasoning.delta` ×2, `text.started`, `text.delta` ×2.
- **Batching.** Two deltas sent in one chunk arrived as one `*.delta` frame (`stats.textDeltaFrames` = 50 for 50 turns). Deltas 150 ms apart arrived as separate frames.
- **Interleaving.** `reasoning.ended` is published after `text.started`, and sometimes after `text.delta` and `tool.input.started`: `f1-frame-order.json` frames, and `01-two-step-tool-turn.json` frames 6–16 (0-based).
- **Envelope.** These frames carry no `durable` key: `session.text.delta`, `session.reasoning.delta`, `session.compaction.delta`, `session.tool.progress`, `session.usage.updated`, `permission.asked`/`replied`, `form.created`/`replied`/`cancelled`, `location.shutdown` and the catalog `*.updated` frames. Every other `session.*` frame observed carries `durable{aggregateID, seq, version}`. That includes `*.started`, `*.ended`, `step.*`, `tool.called/success/failed`, `inbox.*`, `execution.*`, `retry.scheduled`, `revert.*`, `renamed`, `metadata.updated`, `permissions`, `model.selected` and `forked`. `worktree.resolved` carries one too.
- **Scope.** This was one process over loopback with a scripted provider. The first-sight rule never fired here, but the trace does not show the inversion is impossible.

## F2: One assistant message per step? Does a restart reset `time.created`?

**One assistant message per step: yes. A retry reuses the message and resets `time.created`: yes.**

- **One message per step.** Every `session.step.started` of a new step carries a new `assistantMessageID`. Examples: 2 steps and 2 ids in `01-two-step-tool-turn.json`; 4 steps and 4 ids in `06-permission.json`. The REST page lists one `assistant` record per step, plus an `idle` record per execution.
- **Retry on the same message.** In `02-retry.json` the sequence was `step.started{assistantMessageID: msg_…02, started: 1767225606000}`, then `retry.scheduled{assistantMessageID: msg_…02, attempt: 2, at}`, then `step.started{assistantMessageID: msg_…02, started: 1767225610000}`.
- **During the retry.** `retrying.session.messages.asc` shows the assistant with `time.created` 1767225606000, `content: []`, and `retry{attempt, at, error}`.
- **After success.** `session.messages.asc` shows the same assistant with `time.created` 1767225610000 (the second `started`), and the `retry` field is gone.
- **`started` equals `time.created`.** In every vector, `step.started.started` equals the assistant's `time.created`.

## F3: What does `POST /synthetic` produce?

**An inbox item of type `synthetic`. There is no `session.synthetic` event.** All of this is in `11-synthetic.json`.

- **Response.** `session.synthetic` returns 200 with `data` = `Session.Inbox.Synthetic`: `{id: "msg_…", sessionID, time.created, type: "synthetic", payload{text, description, metadata}, delivery: "steer"}`. `steer` is the default delivery.
- **Events on an idle session with the default resume:**
  1. `session.inbox.enqueued{inboxID, item{type: "synthetic", payload, delivery}}`
  2. `session.execution.started`
  3. `session.inbox.delivered{inboxID}`
  4. a normal model step
  5. `session.execution.succeeded`

  The model request's last message is the synthetic text, with role `user` (`llm[1]`).
- **Message id.** The stored message id equals the inbox id. `session.messages.type.synthetic` returns `{id, metadata, time.created, text, description, type: "synthetic"}`.
- **With `resume:false`.** Only `session.inbox.enqueued` is published. No execution starts (`notes.noResumeStartedTurn: false`), and the item stays in `GET inbox` (`session.inbox.afterNoResume`).

## F4: Does `PATCH` metadata merge or replace? Do children and forks inherit metadata?

**`PATCH` replaces. Forks and children inherit.**

- **Replace.** In `09-rename-metadata.json`:
  - `after.a.session.get` shows `{a: 1, devryan: {archive}}`.
  - After `PATCH {metadata: {b: 2, devryan: {todo}}}`, `after.b.session.get` shows exactly `{b: 2, devryan: {todo}}`. `a` and `devryan.archive` are gone, so there is no deep merge.
  - After `PATCH {metadata: {a: null}}`, metadata is `{a: null}`. The null is stored as a value; it does not delete the key.
- **Event payload.** Each metadata PATCH (204) publishes `session.metadata.updated{sessionID, metadata}` carrying the full new map.
- **Forks inherit.** `fork.session.get` has the parent's metadata `{a: null}` and its `permissions`. A fork record has `fork{sessionID, boundary{type: "before" | "through", messageID}}` and no `parentID`.
  - `POST fork` publishes only `session.forked{sessionID, parentID, boundary, instructions}`. There is no `session.created` for a fork.
  - Forked message ids are `<new msg id>_<n>` (`fork.session.messages.asc`).
- **Children inherit.** In `10-child.json`, a child created by the `subagent` tool has `parentID` and the parent's whole metadata, including `devryan.todo.sessionID: "owner-check"`. See `child.session.get` and the child `session.created` frame, which also carries `metadata`.

## F5: Does an in-process `setMetadata` from an SDK plugin tool publish `session.metadata.updated`?

**No. Through the plugin API, metadata is silently dropped.**

- **Observed.** In `09-rename-metadata.json` the `todo_probe` tool called `ctx.session.update({sessionID, metadata})`. The tool succeeded (`todo-written`), but:
  - no `session.metadata.updated` frame was published (`notes.f5MetadataUpdatedFromPlugin: false`);
  - metadata was unchanged in `after.plugin.session.get`.
- **Source.** The plugin session domain's `update` applies only `title` (`sessions.rename`) and `permissions` (`sessions.setPermissions`) and ignores `metadata`: `core/dist/chunks/credential-e34dw6hk.js:525-531`.
- **Title does publish.** A plugin title update persists and publishes `session.renamed`. This was seen in the driver probe `g2trace/01-f5-probe.ts`; it is not a vector.
- **What does publish.** Metadata written through HTTP `PATCH /api/session/:id` publishes `session.metadata.updated` (F4).

## F6: Does the message `type` filter accept several values? Does user `time.created` equal `inbox.delivered.created`?

**`type` accepts exactly one value. User and synthetic `time.created` equal the `inbox.delivered` envelope `created`.**

- **One value only.** Both multi-value forms return 400 `InvalidRequestError` (`kind: "Query"`), in `11-synthetic.json`:
  - `?type=user,synthetic` (`session.messages.type.multiComma`);
  - `?type=user&type=synthetic` (`session.messages.type.multiRepeat`).

  The OpenAPI enum for `type` also omits `idle`.
- **Delivery time.** In every vector with a delivery (`01`–`12`), a user or synthetic message's `time.created` equals the `created` of its `session.inbox.delivered` frame.
- **Admission time.** The prompt response's `time.created` equals the `session.inbox.enqueued` frame's `created`, and is earlier. For example, in `02-retry.json`: enqueued and prompt are 1767225602000, delivered and user are 1767225605000.

## F7: On `SubscriberOverflow`, does the response end cleanly or abort mid-chunk?

**The handler's body stream errors. Through a Bun listener it showed up as a clean end of a chunked body. A plain non-reading TCP peer did not overflow at all.** All three results are in `13-stream-drop.json` `notes`.

- **Unread handler body (`handlerUnreadBody`).** The `/api/event` Response came straight from the in-process handler and was not read while 5000 events were published.
  - Reading it afterwards gave 4110–4116 data frames, depending on the run. The capacity is 4096, plus frames already pulled.
  - Then `read()` rejected with `EventFeed.SubscriberOverflow`. The stream failed; it did not finish with `done`.
  - Source: `server/dist/chunks/server-info-n9y13hgv.js`, where the feed fails the subscriber queue with `SubscriberOverflowError` when `Queue.offerUnsafe` on the 4096-slot dropping queue fails.
- **Gated Bun listener (`listenerGatedTcp`).** A Bun listener forwarded that body but stopped pulling it while 5000 events were published. A raw HTTP/1.1 client then received 4110–4117 data frames, depending on the run, and a clean chunked terminator `0\r\n\r\n` (`endsWithChunkedTerminator: true`). The socket stayed open, with no `end`, `close` or `error`.
- **Paused TCP peer on the G1 listener (`pausedSubscriber`).** A TCP client stopped reading `/api/event` while 6000 events were published. No overflow happened: after resuming it received all 6001 frames, and the connection stayed open.
  - Bun kept pulling the stream and buffering it, whatever the TCP backpressure.
  - Every one of the 6000 PATCHes returned 204.
- **Reading subscriber.** A normally reading subscriber received all 6000 frames during the same flood (`readingSubscriber`).

## F9: Do v2 location routes ignore or reject unknown query keys such as `directory`?

**They ignore them.** All of this is in `f9-location-query.json`.

- `GET /api/location?directory=<home>/workspace-other` returns 200 and resolves to the process cwd (`<home>`), not to the requested directory (`location.directoryQuery`).
- `?bogus=1` is ignored, with a 200 (`location.header+bogusQuery`, `agent.bogusQuery`).
- **Honoured.** These set the location:
  - the `?location[directory]=` query (`location.locationQuery`);
  - the `x-opencode-directory` header, URL-encoded or raw (`location.header`, `location.header.unencoded`).
- **Header wins over `directory`.** With the header plus `?directory=`, the header's directory is used (`location.header+bogusQuery`).
- **No location.** This falls back to the process cwd (`location.none`).
- **Missing directory.** A `location[directory]` that does not exist returns 500 with an empty body (`location.missingDirectory`).

## F11: Does `TokenUsage.input` include cached tokens?

**No. `input` is uncached input, and `output` excludes reasoning.**

- **Step 1.** In `01-two-step-tool-turn.json` the provider sent `prompt_tokens: 1000`, `cached_tokens: 400`, `completion_tokens: 50` and `reasoning_tokens: 10`. `session.step.ended` reported `tokens {input: 600, output: 40, reasoning: 10, cache: {read: 400, write: 0}}`.
- **Step 2.** The provider sent `1200 / 1000 cached / 20`. The step reported `{input: 200, output: 20, reasoning: 0, cache.read: 1000}`.
- **Session totals.** `session.usage.updated` and `GET session` (`session.get`) hold the sums: `{input: 800, output: 60, reasoning: 10, cache.read: 1400}`.
- **Source.** The OpenAI-chat usage mapping computes `nonCachedInputTokens = prompt_tokens − cached − cacheWrite` (`ai/dist/protocols/openai-chat.js:724-746`), and core maps `input: nonCachedInputTokens`, `output: visibleOutputTokens` (`core/dist/chunks/credential-tdstcens.js:17-25`).

## F12: Does `switchModel` while busy change the running turn's next step?

**Yes.** All of this is in `12-steer-queue-switch.json`.

- **The switch.** While step 1's `sim_probe` tool was held, `POST /api/session/:id/model {m2}` returned 204 and immediately published `session.model.selected{model: {id: "m2", providerID: "sim"}}`.
- **Same execution, new model.** The same execution's next step ran on `m2`:
  - `step.started.model` = `{id: "m2", providerID: "sim", variant: "default"}`, so the switch added `variant: "default"`;
  - the model request went to `m2` (`llm[1].model`);
  - `GET session` afterwards has `model{id: "m2", variant: "default"}`.
- **Inbox order in that run.** The `steer` prompt sent during step 1 was delivered after step 1 ended and before step 2. The `queue` prompt was delivered after step 2 ended. Both ran in the same execution: one `execution.started`, three `step.started`, one `execution.succeeded` (`notes.terminals`).

## Also observed (outside the assigned questions)

- **F8.** With `snapshots:false`, `GET /api/session/:id/diff` returned `{data: []}` after a turn that wrote `notes.txt`. This held for the default form, for `?from=<user>&context=3`, and after a second turn (`06-permission.json`: `session.diff.*`). The file data appears only in `permission.asked.metadata.files[]` (patch, additions, deletions, status). The completed `write` tool's `state.metadata` and its `session.tool.success.metadata` are `{truncated: false}`, with no `files`, diff or counts (`session.messages.asc`).
- **Dismissed question.** Cancelling a `question` tool form gave `tool.failed{type: "aborted"}`, `step.failed{aborted}` and `session.execution.interrupted{reason: "shutdown"}`. The session was then absent from `GET /api/session/active`, and the next prompt ran normally (`05b-question-dismissed.json`).
- **Cold catalog.** On the first request to a new location, `GET /api/agent`, `/api/provider` and `/api/model` returned `data: []`. They were populated once the location finished loading (`00-catalog-cold.json` vs `15-catalog-warm.json`).
- **Compaction.** A successful compaction published `session.compaction.started/delta/ended` inside an execution, and no `session.compacted` frame (`07-compaction.json`).
- **Revert.** `DELETE revert` (clear) was followed by an `execution.started`/`execution.succeeded` pair with no step. `revert/commit` removed every message from `to` onward (`08-revert.json`: `committed.session.messages.asc`).
- **Tool input deltas.** A tool call streamed with input deltas produced `tool.input.started` and `tool.input.ended{text}`, but no `session.tool.input.delta` frames (`01-two-step-tool-turn.json`).
