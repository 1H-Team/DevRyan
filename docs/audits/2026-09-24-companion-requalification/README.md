# Duplicate-output requalification on DevRyan companion 2.0.0

Date: 2026-09-24. This requalifies the `duplicateOutputs` projection on the
shipped runtime.

## Profile identity

| Field | Value |
| --- | --- |
| Runtime | DevRyan companion 2.0.0 executable (`dc0954bd…`), reporting OpenCode `1.18.31` |
| Transport | OpenAI managed ChatGPT OAuth Responses (`openai-chatgpt-managed-responses-v1`) |
| Model | `gpt-5.6-sol` Medium |
| Provider hash | Unchanged (`4792784f…`) |
| Managed plugins | 21 entries, ordered |

The previous profile (`opencode-1.18.31-openai-sol-medium`, see the
[2026-09-20 audit](../2026-09-20-context-deduplication/README.md)) stays on
record as stale.

## Gates

- **Deterministic tests.** Projection, managed-dispatch, skill, host
  qualification and warmup coverage passed. This includes the new
  repeated-instruction (Plan-mode preface) reference.
- **Native serializer probe.** Run on the companion executable
  (`node scripts/qa/cache-serializer-probe.mjs <companion> --duplicates`). The
  first run timed out at startup before any request and is retained as failed
  evidence. The next two runs passed every check.
- **Collector check, first batch.** The first acceptance round failed the
  collector check (retained under the runner's round-1 output). Each host start
  sent `GET /health`, which is not an OpenCode route, so the runtime proxied it
  to `app.opencode.ai`. Installed apps did the same on every start. The warmup
  now uses `/global/health`. Nothing else changed; runtime, plugin and provider
  hashes are identical.
- **Pilot and 10-pair acceptance.**
  - [`live-pilot.json`](live-pilot.json) and
    [`live-acceptance.json`](live-acceptance.json) passed, with the collector
    clean: 5 skill and 5 managed pairs.
  - Zero critical failures, repeated mutations and extra same-key calls.
  - Requests never grew, and canonical history is unchanged.
  - System and tool prefixes are identical, and no unexpected egress occurred.
  - The report's SHA-256 is the profile's `reportHash`.
- **Plan-mode preface pairs.**
  - One batch failed ([`instruction-reuse-live-failed.json`](instruction-reuse-live-failed.json)):
    an "off" response dropped mid-stream after HTTP 200 and was retried. It is
    retained.
  - A fresh 3-pair batch ([`instruction-reuse-live.json`](instruction-reuse-live.json))
    passed 6/6. Correct plans were produced, with two references and one full
    copy.

Enablement accounting is in [`enablement.json`](enablement.json). Structural
evidence is in [`evidence.json`](evidence.json).

## Measured (primary requests, 10 per arm)

| | Projection off | Projection on |
| --- | ---: | ---: |
| Serialized size | 84,412–92,940 bytes | 60,766–65,488 bytes |
| Total provider input | 173,494 tokens | 122,723 tokens (−29%) |
| Provider cache reads | 15,360 | 19,968 |
| Peak provider input | 18,246 | 12,809 |

- Plan-mode pairs went from 46,673 to 38,205 bytes, and from about 9,133 to
  7,415 input tokens per trial.
- The hook took 0.79 ms at the median and 15.4 ms at most.
- Baselines ran before candidates, so this is a correctness qualification, not
  a latency or monetary comparison.

`DEVRYAN_DUPLICATE_OUTPUTS=0` disables projection after the normal
managed-host restart.
