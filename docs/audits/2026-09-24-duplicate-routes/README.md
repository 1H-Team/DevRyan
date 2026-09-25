# Duplicate-output qualification on DevRyan companion 2.1.0 (four routes)

Date: 2026-09-24. This qualifies the `duplicateOutputs` projection for four
selected routes on the companion 2.1.0 build of OpenCode 1.18.32. The previous
OpenAI profile is stale (`devryan-managed-orchestration.mjs` changed), see the
[companion 2.0.0 audit](../2026-09-24-companion-requalification/README.md).

## Profile identity

| Field | Value |
| --- | --- |
| Runtime identity | `companion-build`: upstream `1.18.32`, base commit `545f51d2…`, patch `059919cc…`, build inputs `58947519…` |
| Qualified executable | `d1f46380…` (a rebuild from the same source and build inputs keeps the qualification; `DEVRYAN_DUPLICATE_IDENTITY=binary` pins this hash instead) |
| Policy vector | `waitAny: false`, `capabilityToolSchema: true` |
| Managed plugins | 21 entries, ordered, including the new `devryan-open-cursor.mjs` adapter |

| Route | Transport | Provider hash |
| --- | --- | --- |
| `xai/grok-4.7` medium | `xai-oauth-responses-v1` | none (no `provider.xai` configuration) |
| `xai/grok-4.6` high | `xai-oauth-responses-v1` | none |
| `openai/gpt-6-astra` medium | `openai-chatgpt-managed-responses-v1` | `4792784f…` (unchanged) |
| `openai/gpt-5.6-sol` medium | `openai-chatgpt-managed-responses-v1` | `4792784f…` |

Claude through Meridian is not qualified: its Anthropic Messages traffic goes to
Meridian on loopback, which the wire proxy cannot observe, and the host attests
no Anthropic transport (see [HARNESS_OPTIMIZATION.md](../../HARNESS_OPTIMIZATION.md#live-routes)).

## Gates

- **Deterministic tests.** `bun run validate:full` passed on the frozen tree,
  with `bun run build` and `bun run bundle:check`. The companion build passed its
  14 acceptance scenarios.
- **Native serializer probe** on the companion executable: runs 1 and 3 passed
  every check ([`serializer-probe-1.json`](serializer-probe-1.json),
  [`serializer-probe-3.json`](serializer-probe-3.json)). Run 2 timed out on the
  candidate arm while two live runs shared the machine and is retained
  ([`serializer-probe-2.json`](serializer-probe-2.json)).
- **Per route** (`<route>/`): pilot (`live-pilot.json`), ten-pair acceptance
  (`live-acceptance.json`, 5 skill and 5 managed pairs) and a three-pair
  Plan-mode instruction-reuse supplement (`instruction-reuse-live.json`). Every
  trial completed with facts intact and canonical history unchanged; zero
  critical failures, repeated mutations and extra same-key calls; requests never
  grew; no wire or collector failures. The acceptance report's SHA-256 is the
  profile's `reportHash`.
- **Retained failed attempts** (`<route>/failed/`):
  - `xai-47` pilot 1: each arm's last request (a session title) was cut when the
    runner deleted its session while the response was still streaming, recorded
    as `transport-failed`. The runner now waits for in-flight wire requests
    before deleting a session or stopping an arm.
  - `xai-47` instruction supplement 1: the supplement inspected only string
    bodies, but the proxy forwards raw bytes, so no sizes were measured; one
    candidate trial also returned an empty plan. The rerun passed 6/6.
  - `openai-astra` pilot 1 left no report: a model-catalog download failed after
    its headers were forwarded and the proxy threw. The proxy now ends that
    response; a regression test covers it.

## Measured (primary requests, 10 per arm)

| Route | Serialized size off | on | Provider input off | on |
| --- | ---: | ---: | ---: | ---: |
| grok-4.7 medium | 87,631–96,159 B | 63,985–68,707 B | 208,040 | 154,619 (−25.7%) |
| grok-4.6 high | 87,629–96,157 B | 63,983–68,705 B | 201,972 | 148,551 (−26.4%) |
| gpt-6-astra medium | 84,298–92,826 B | 60,652–65,374 B | 173,182 | 122,406 (−29.3%) |
| gpt-5.6-sol medium | 84,319–92,847 B | 60,673–65,395 B | 173,160 | 122,388 (−29.3%) |

Instruction reuse (Plan-mode preface repeated byte-identically) cut the final
request from 49,397 to 40,929 bytes on xAI and from 46,559–46,580 to
38,091–38,112 bytes on OpenAI. Provider input counts are provider-reported token
counts for the ten primary requests; they are not billing or quota claims.

## Default verification

After promotion, each route ran `--verify-default` (2 pairs; the candidate arm
without `DEVRYAN_DUPLICATE_OUTPUTS`, so only the release profile enables the
projection). All four passed (`<route>/verify-default.json`): the candidate
applied 2 reductions per trial with a clean wire. The first `openai-sol` run is
retained under `failed/`: a baseline request failed before response headers
(upstream connection error) while another route ran concurrently, OpenCode
retried it, and the extra request exceeded the pilot's request cap. Run alone,
it passed.
