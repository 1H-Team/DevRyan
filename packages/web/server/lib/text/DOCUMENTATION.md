# Text Module Documentation

## Purpose
This module provides shared text transformation and direct Zen generation helpers that are not owned by a single product surface. It contains the summarization pipeline used by TTS, notifications, and note distillation flows plus a direct text-generation transport available to Git utilities. Production Git routes inject native OpenCode helper transport instead.

## Entrypoints and structure
- `packages/web/server/lib/text/summarization.js`: Shared summarize + sanitize helpers backed by opencode.ai zen API.

## Public exports

### Summarization (summarization.js)
- `generateZenText({ prompt, sessionID, zenModel, timeoutMs, chatMaxTokens, chatReasoningEffort, responsesMaxOutputTokens, stop, signal })`: Send one bounded non-streaming prompt directly to the appropriate Zen Responses or Chat Completions endpoint and return extracted text. Caller cancellation is forwarded to the HTTP request and its listener is removed on completion. This helper does not create OpenCode sessions. It sends `x-opencode-session` on both endpoint formats. `resolveZenSessionID(sessionID)` validates explicit opaque IDs (1–256 ASCII letters, digits, underscores or hyphens), rejecting placeholders and invalid header values, or generates a UUID when omitted. Callers resolve identity before retry/model-rotation loops; separate standalone operations receive separate IDs. `summarizeText` and direct Git generators preserve that identity through retries/rotation. Notifications pass their actual conversation ID; note fallback shares its operation ID. `ZenApiError.providerType` retains the upstream error type, distinguishing `MissingSessionID` from rate limiting without changing cooldown policy. No CLI identity headers are fabricated. Muse Spark models use the Responses endpoint, matching Zen's endpoint catalog; routing them to Chat Completions can return an upstream 500.
- `summarizeText({ text, sessionID, threshold, maxLength, zenModel, mode })`: Shared summarization entrypoint.
- `sanitizeForTTS(text)`: Sanitizes text for speech output.
- `sanitizeForNotification(text)`: Sanitizes text for compact notification output.
- `sanitizeForNote(text)`: Sanitizes text for short note/distillation output.
- `sanitizeForTitle(text)`: Sanitizes model output into a concise session title without markdown, common `Title:` / `Session title —` wrappers, or trailing punctuation.

## Modes
- `tts`: Speakable summary for TTS flows.
- `notification`: Short plain-text summary for notification bodies.
- `note`: Distilled short project-memory note.
- `title`: Three-to-seven-word sentence-case session title with no markdown, quotes, or trailing punctuation. Titles name the durable subject, problem, or desired outcome rather than Plan mode or a requested planning deliverable. The source request is JSON-encoded and explicitly isolated as untrusted data so directives inside the request cannot replace the title contract. A source-aware local correction removes incidental leading planning phrases without another model request while preserving literal Plan concepts such as Plan mode and Plan cards.

## Response contract

### `summarizeText`
Returns object with:
- `summary`: Final transformed text.
- `summarized`: Boolean indicating whether model summarization succeeded.
- `reason`: Optional failure/skip reason.
- `originalLength`: Optional original text length.
- `summaryLength`: Optional final summary length.

## Notes for contributors
- Keep this module neutral. Do not re-couple it to TTS-specific naming or routing.
- Add new mode semantics here when multiple product surfaces need the same text pipeline.
- Prefer mode-specific prompt and sanitize behavior over creating duplicated summarizers in unrelated modules.
- Callers may provide a total generation deadline, per-request timeout, retry count, output limits, stop sequences, and all-model-cooldown behavior. Session titles use an eight-second total deadline, 4.5-second requests, 32 output tokens, no same-model retries, and immediate fallback when every candidate is cooling down.

## Session-header verification (2026-09-08)

An isolated repository-local OpenCode 1.18.29 process sent requests to a loopback
model fixture for both `opencode` and `opencode-go`. Two turns in one session
preserved `x-opencode-session`; a second session used a distinct ID. Requests
also included native project, client, user-agent and distinct message/request
identities. This verifies native transport, not paid Go live-provider access.
Production chat and Git helper routing therefore need no additional header hook.

Direct live probes without the session header returned HTTP 400 `MissingSessionID`.
The updated `generateZenText` returned `OK` from `muse-spark-1.3-contributor-free`
through Responses with the header. Chat Completions attempts for Muse had returned
500 before the endpoint correction. Other free-model probes encountered rate
limits, timeouts or model-unavailable responses; the change does not promise
capacity or resolve those failures. Historical user journals and paid Go account
access were not inspected. Deterministic tests mock provider traffic and cover
identity separation, retry/rotation/fallback stability, both endpoint formats,
invalid IDs, cancellation and provider error types.
