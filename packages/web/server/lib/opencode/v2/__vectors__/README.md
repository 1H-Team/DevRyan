# OpenCode 2.0.20 wire vectors

These files are real traces from an unmodified OpenCode 2.0.20. Every file was captured, not written by hand. They pin the gen-2 inputs that the Phase 2 adapters consume: the projection (`v2/projection/*`), the event projector, the v2 loopback fixture, and the façade. Answers to the design's open questions F1–F7, F9, F11 and F12 are in [ANSWERS.md](ANSWERS.md).

## How they were captured

- **Host.** The throwaway driver is not checked in: `.cache/v2-spike/g2trace/capture.ts`. It runs on the G1 embedded host (`.cache/v2-spike/g1/lib/host.ts`):
  - `ServerFetch.make` behind a Bun listener on `127.0.0.1:0`, with Basic auth;
  - a private HOME, with the process cwd set to that HOME;
  - `snapshots:false` and `events.persist:false`.
- **Model turns.** These come from the OpenCode simulation backend (`@opencode/simulation`, Drive WebSocket). The driver scripts every chunk (`textDelta`, `reasoningDelta`, `toolInputStart`/`toolInputDelta`, `toolCall`, and `raw` usage or error chunks) and every finish. No real provider is contacted.
- **Provider and model.** The provider is `sim`, with models `m1` and `m2` (`@ai-sdk/openai-compatible`).
- **Tools.** There are two extra tools:
  - `sim_probe` is a simulated tool driven over the Drive socket (`tool.update` gives progress, `tool.finish` gives the result).
  - `todo_probe` is an SDK plugin tool that calls `ctx.session.update({metadata})`. It is used for F5.
- **Overlay.** It adds one skill (`probe-skill`) and one command (`probe`).
- **Recording.** One reader on `GET /api/event` records every frame as the exact text received. A frame is one SSE block, including its `\n\n` terminator. Each REST call made by the driver is recorded with method, path, request body, status, content type and response body.
- **Commands.** From `.cache/v2-spike`, run:
  - `g2trace/run.sh capture.ts g2trace-capture` (writes `homes/g2trace-capture/raw/capture.json`, not tracked);
  - `node g2trace/normalize.mjs homes/g2trace-capture/raw/capture.json <this directory>`.

  `bun g2trace/validate-vectors.ts <this directory>` decodes every data frame with `@opencode/schema@2.0.20` `EventManifest.Latest`. It passed for all 485 frames.

## File shape

Every `*.json` vector except `index.json` and `openapi.json` has this shape:

```json
{
  "vector": "01-two-step-tool-turn",
  "title": "…",
  "design": "D1 (+F11 usage)",
  "opencode": "2.0.20",
  "capturedWith": "…",
  "normalization": { "ids": 0, "timestamps": 0, "sha256": 0, "sha1": 0, "slugs": 0, "timestampBase": 1767225600000, "timestampStep": 1000 },
  "frames": ["data: {…}\n\n"],
  "rest": [{ "label": "session.get", "method": "GET", "path": "/api/session/ses_…", "headers": {}, "request": {}, "status": 200, "contentType": "application/json", "body": {} }],
  "llm": [{ "kind": "primary", "model": "m1", "messages": 2, "lastRole": "user", "lastText": "…" }],
  "notes": {}
}
```

- `frames` holds the `/api/event` frames received while the sequence ran, in arrival order, as exact text after normalisation.
  - `: heartbeat\n\n` comment frames are dropped, because they come from a 15 s timer and belong to no sequence. When any were dropped, `notes.heartbeatFramesDropped` counts them.
  - The stream is global, so a frame from an earlier sequence can occasionally land in the next one.
- `rest[].body` is the parsed JSON response, re-serialised; `null` means an empty body. A non-JSON body is kept as `bodyText`. `headers` appears only when the driver sent extra headers, which is always `x-opencode-directory`.
- `llm` summarises the model requests the simulation backend received (kind, model, message count, last message). Request bodies are not kept, because they hold the system prompt.
- `notes` holds driver observations: terminal event, experiment statistics and overflow results.
- `index.json` lists every file with its title and frame and REST counts.
- `openapi.json` is `GET /openapi.json` exactly as served (one line), plus a trailing newline.
  - It is JSON-equal to `../openapi-2.0.20.json`, which is the pretty-printed G1 boot-probe copy.
  - It contains no ids, paths or timestamps, so it is unnormalised.

## Normalisation (`normalize.mjs`, deterministic for a given capture)

1. **Paths.** The private home becomes `<home>`; its URL-encoded form becomes `%3Chome%3E`. The repo root becomes `<repo>` and the user home becomes `<user-home>` (neither occurs in the current vectors). `127.0.0.1:<port>`, `"pid":0` and `Date: <date>` replace the port, pid and Date header. Every `apiKey` value becomes `"<redacted>"`.
2. **Opaque cursors.** Strings starting `eyJ` are base64url JSON: message cursors are `{id, order, direction}` and session cursors are `{directory, anchor{id, time, direction}, parentID?}`. Each is decoded, normalised by the same rules, and re-encoded.
3. **Ids.** These match `(ses|msg|evt|frm|per|psv|con|pty|sh|wrk|cred)_` followed by 12 hex characters and 14 alphanumerics. Each file has its own map, which keeps both the prefix and the sort order:
   - Ascending ids become `<prefix>_<12-hex rank>normalized0000` (rank 1 is the oldest), so `msg_000000000001normalized0000` is the first message.
   - Session ids are descending in v2 (newest sorts first), so they become `ses_<ffffffffffff − rank>normalized0000`. The first session is `ses_fffffffffffenormalized0000`.
   - Suffixes survive. Forked messages keep v2's `<id>_<n>` form, for example `msg_…normalized0000_4`.
   - Tool call ids (`call_s01_probe`, …) are chosen by the driver and left unchanged.
4. **Hashes.** These are content hashes in `session.instructions.updated`/`session.forked` instruction maps (64 hex) and path-derived project ids (40 hex). They become zero-padded hex counters in first-seen order, so they still match `^[a-f0-9]{64}$`.
5. **Slugs.** Generated session slugs (`adjective-noun`) become `slug-<n>` in first-seen order.
6. **Timestamps.** Every epoch-millisecond number (13 digits, `1[789]…`) is replaced by its rank among the distinct values in that file: `1767225600000 + rank × 1000`. Order and equality are preserved, but intervals are not. For example, `retry.scheduled.at` minus `created` no longer equals the real delay.
7. **Guard.** Normalisation fails if any output, including decoded cursors, still contains `/Users/`, `Repositories/DevRyan`, `v2-spike/homes`, the user name, the simulated API key or a `Basic` credential.

Two captures from separate runs were normalised and compared, with timestamps and cursor strings masked (cursors embed an anchor time). Every file was identical except `13-stream-drop.json`, whose overflow frame counts, byte counts and excerpts vary from run to run. So the structure (event order, types, ids, payload shapes) was stable across both runs. Timestamp equalities can differ between runs, because events can land in the same millisecond.

## Files

| file | sequence (DESIGN.md D) | what it contains |
|---|---|---|
| `00-catalog-cold.json` | catalog | First touch of a new location: `info`, `agent`, `provider`, `model`, `model/default`, `integration`, `command`, `skill`, `mcp`, `config` (entry list), `location`, `project`, `vcs`, `plugin`, `form`, `permission/request`, `session/active`, `session` list. Agents, providers and models are **empty** on first touch, because the location loads asynchronously; frames show the `*.updated` catalog events arriving afterwards. |
| `15-catalog-warm.json` | catalog | The same routes once the location is warm, plus `vcs/status`, `permission/saved`, `reference`, `integration/sim`, `provider/sim`, `agent/build`, and session list pages (`limit=3`, `parentID=null`). |
| `openapi.json` | — | `GET /openapi.json` (116 path templates). |
| `f9-location-query.json` | F9 | `GET /api/location` with no location, with `?directory=`, with `?location[directory]=`, with the `x-opencode-directory` header (encoded and raw), with a header plus bogus and `directory` query keys, `GET /api/agent?bogus=1`, and a nonexistent `location[directory]`. |
| `01-two-step-tool-turn.json` | D1 | Reasoning and text deltas at 150 ms spacing, a streamed tool input (`toolInputStart` plus 2 deltas) for `sim_probe`, two `tool.progress` updates (the second carries `sessionID`), `tool.success`, `step.ended(tool-calls)`, step 2 text, `step.ended(stop)` and `execution.succeeded`. Provider usage chunks have cached and reasoning tokens (F11). Mid-run REST (`mid.*`): `session/active`, `inbox`, `message` and `session` while the tool runs. Afterwards: `session`, `message` asc, desc `limit=2` plus `cursor.next`, `cursor`+`order` (400), `type=user`, `type=assistant`, default order, `message/:mid`, `diff`, `inbox`, `active` and `context`. |
| `f1-frame-order.json` | F1 (D1 `deltaFirst`) | 50 one-step reasoning+text turns in one session. Frames are kept for the first turn only; `notes.perTurnTypes` lists all 50 per-turn type sequences and `notes.stats` counts order inversions. |
| `02-retry.json` | D2 | The first attempt gets a `raw` provider error `{code:429}` before any output, then `retry.scheduled`, then a successful attempt on the same assistant. REST during the retry (`retrying.*`) and after. |
| `03-abort.json` | D3 | Partial text, then `POST interrupt` (`{interrupted:true}`), then `step.failed{aborted}` and `execution.interrupted{reason:user}`. A second interrupt on the idle session returns `{interrupted:false}`. |
| `04-failure.json` | D4 | A `raw` provider error `{code:401}`: `step.failed{provider.auth}` and `execution.failed{provider.auth}`. |
| `04b-tool-failed.json` | — | A `question` tool call with invalid arguments gives `tool.failed{type:"tool.execution"}`; the next step answers. |
| `05-question-form.json` | D5 | The `question` tool (single plus multiselect) gives `form.created{form}`. Pending `GET /api/form`, session form list and get, and the in-flight assistant message (tool `running`). Reply `{answer:{q0, q1:[…]}}` gives `form.replied`. Then a typed form over HTTP (`string`, `string`+options, `number`, `integer`, `boolean`, `multiselect`) is replied, and an `external`-field form is created, listed and cancelled (`form.cancelled`). |
| `05b-question-dismissed.json` | D5 | A question form is cancelled (`DELETE`) while the turn waits. This gives `tool.failed{aborted}`, `step.failed{aborted}` and `execution.interrupted{reason:"shutdown"}`. Then `session/active`, `inbox`, and a follow-up prompt that succeeds. |
| `06-permission.json` | D6 | A session with ruleset `edit:* ask`. `write` gives `permission.asked` (`action:"edit"`, `resources`, `save`, `metadata.files[].patch`, `source{type:"tool", messageID, id}`). Pending lists and get, then reply `once` and `tool.success`. A second write is rejected with a message (`tool.failed{permission.rejected}`). `GET diff` (default, `from`+`context=3`, after) runs with `snapshots:false`. |
| `07-compaction.json` | D7 | One turn, then `POST compact`: `inbox.enqueued{compaction}`, `compaction.started{reason:manual}`, `compaction.delta`, `compaction.ended{text}`, all inside an execution. `message?type=compaction`, `context`, and a turn after compaction. |
| `08-revert.json` | D8 | Two turns, `revert/stage{messageID: 2nd user}` (`files:[]`), `DELETE revert` (`revert.cleared`), stage again, `revert/commit` (`revert.committed{to}`). Messages from `to` onward are gone afterwards. |
| `09-rename-metadata.json` | D9 | A session without a title: title generation gives `session.renamed`. Then `PATCH title`, three metadata PATCHes (archive, todo, `{a:null}`), a `PATCH permissions` (`session.permissions`), the in-process plugin metadata write (F5), `fork{before}` and `fork{}` (`session.forked`), and the forked session's record and messages. Session lists by directory and roots. |
| `10-child.json` | D10 | A parent with metadata, then the `subagent` tool: child `session.created{parentID, agent, metadata}`, parent `tool.progress{metadata:{sessionID: child, status:running}}`, the child's own turn, parent `tool.success`. Parent and child records and messages, `session?parentID=`. |
| `11-synthetic.json` | D11 | `POST synthetic` on an idle session (default resume) runs a turn. `POST synthetic {resume:false}` only enqueues. Then `inbox`, `message?type=synthetic`, and the two multi-value `type` filters (both 400). |
| `12-steer-queue-switch.json` | D12 | While `sim_probe` is held: `POST model {m2}` (`session.model.selected`), a `steer` prompt and a `queue` prompt, then `inbox` and `active`. After release, the steer is delivered before step 2 and the queue item after step 2, in one execution. `llm[]` shows which model each step used (F12). |
| `13-stream-drop.json` | D13 | F7 overflow experiments (see ANSWERS.md). `frames` keeps only the first 6 and last 4 frames of the reading subscriber; `notes` holds the paused-TCP, unread-handler-body and gated-listener results, with head and tail excerpts. |
| `14-location-shutdown.json` | D14 | `POST location/reload` and `DELETE debug/location`. Four `location.shutdown` frames (`data:{}`, directory in the envelope `location`), followed by catalog `*.updated` frames as the locations reload. |

What could not be produced, and why:

- **D1 `deltaFirst:true`.** A real trace never published a delta before its durable `*.started` event: 0 of 50 turns, plus the 150 ms-spaced D1 turn. So there is no real `deltaFirst` vector, and the fixture has to synthesise that ordering.
- **D13 over a real TCP listener.** A subscriber that stops reading on the G1 Bun listener never overflowed, because Bun kept buffering. The overflow was produced at the handler level and through a listener that stops pulling the handler body (`notes` in `13-stream-drop.json`).
- **`session.tool.input.delta`.** No frame of this type was observed, even with two input deltas 150 ms apart.
- **`session.compacted`.** No frame of this type was observed after a successful compaction.
