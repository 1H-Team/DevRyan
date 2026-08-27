# Text Module Documentation

## Purpose
This module provides shared text transformation and direct Zen generation helpers that are not owned by a single product surface. It contains the summarization pipeline used by TTS, notifications, and note distillation flows plus a session-free text-generation transport used by Git utilities.

## Entrypoints and structure
- `packages/web/server/lib/text/summarization.js`: Shared summarize + sanitize helpers backed by opencode.ai zen API.

## Public exports

### Summarization (summarization.js)
- `generateZenText({ prompt, zenModel, timeoutMs, chatMaxTokens, chatReasoningEffort, responsesMaxOutputTokens, stop })`: Send one bounded non-streaming prompt directly to the appropriate Zen Responses or Chat Completions endpoint and return extracted text. This helper does not use OpenCode sessions.
- `summarizeText({ text, threshold, maxLength, zenModel, mode })`: Shared summarization entrypoint.
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
