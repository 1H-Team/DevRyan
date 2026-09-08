# Plugin upgrade evidence — September 8, 2026

Implementation follows [the permanent upgrade runbook](../../PLUGIN_UPGRADES.md).
The original working tree already contained extensive user changes. No user
changes, personal configuration or running installation are reset or replaced.

## Version decisions

| Component | Previous | Candidate | Decision |
| --- | --- | --- | --- |
| Oh My OpenCode Slim | 2.2.15 | 2.2.18 | Accepted independent upgrade |
| Open Cursor | 2.5.4 | 2.5.8 | Accepted independent upgrade |
| GPT Image Generation | 0.1.10 | 0.1.12 | Accepted independent upgrade, including Bot image |
| OpenCode with Claude | 1.8.0 | 1.10.1 | Held: candidate fails strict history-stability acceptance |
| Meridian | 1.62.6 | 1.68.0 | Candidate source port prepared; selected version remains 1.62.6 |
| Claude Code | 2.1.215 | 2.1.260 | Meets new Meridian minimum; held with the tuple |
| Claude Agent SDK | 0.2.141 | 0.2.141 | Retained |
| Context Mode / Antigravity | 1.0.169 / 1.6.0 | Same | Already current stable releases |

Exact published package integrity and tarball SHA-256 values are retained in
[packages.json](packages.json). [Installed package review](installed-package-review.json)
found no differences from published packages except Meridian's known corrected
bundle, SHA-256 `3780a40b4d02927087565706ce3e8d4cb355be8cd8c6b6b0be44f4c497cf5114`.

## Customization and upstream-change decisions

- Preserve personal per-agent model/variant assignments and disabled Slim MCPs.
  Personal Meridian settings select native Claude instructions and disable the
  additional client system prompt. Do not copy these preferences into global
  clean-user defaults.
- Slim's upstream primary/specialist prompt text is unchanged; the agent factories remove hard-coded temperatures. DevRyan preserves its own prompts and any explicit temperatures.
- Preserve the working tree's stronger Context Mode timeout/worker failure and
  unknown-outcome recovery instructions in all affected primary/specialist agents.
  No upstream prompt wholesale replacement or model reassignment is included.
- Slim's new inheritance and concurrency support remains opt-in through existing
  configuration. Its retained final-agent object required an adapter correction:
  restoring only the outer property left its admission closure with temporary
  models. Restore the retained object in place, including failure paths.
- Open Cursor adds task/subagent argument normalization, schema-aware edit repair
  hints and credential selection handling. Its provider identity remains
  `cursor-acp`; DevRyan's independent Cursor SDK runtime is unchanged by this work.
- GPT Image Generation's published 0.1.12 executable is byte-identical to 0.1.10.
  The package version does not establish which hosted image model OpenAI selects.
- Meridian 1.68.0 already includes passthrough checkpoint forks and new session
  publication protections. Keep those upstream changes. Port the missing normal
  SDK mode, forwarded-tool stop, stable Git prefix and verified handoff corrections
  without changing its explicit session IDs or replay-provenance instructions.

## Verification record

- Baseline: 107 focused web Vitest tests passed. An initial invocation through
  `bun test` from the repository root was invalid for these Vitest tests and failed;
  it was corrected without changing assertions.
- Final focused preservation/source/guard checks: 101 tests passed. The prefix
  and quota evidence contract checks passed all 16 tests.
- Real installed Slim 2.2.18 preserved synthetic and sanitized personal host agent
  models, variants, prompts, permissions and disabled MCPs.
- Real image plugin passed synthetic SSE generation, reference image, quality,
  size, non-overwriting output and missing-auth checks. No provider call was sent.
- Candidate Meridian patch applies idempotently to the exact published source;
  patched JavaScript parses. Source hash and partial-patch refusal tests cover
  both supported bundle versions.
- Native macOS prefix probe stopped before inference: sandboxed `/bin/ps` access
  is denied, so Meridian cannot capture the owner process incarnation required
  for its cross-process turn lock. The lock protection was not weakened.
- Linux Docker verification used Bun 1.3.14, Node 22.13.1, actual native Claude
  binaries and `--network none`. The image needed a unique container machine ID
  and the fixture needed libsql's libc-qualified native dependency. All native
  process/lock checks stayed intact. A registry integrity failure interrupted the
  first install; the independently fetched tarball matched registry integrity,
  and the retry succeeded with integrity validation enabled.
- No Claude live quota was consumed. Paid comparison was not admitted after the
  candidate failed offline acceptance. The selected tuple and its September 7
  caching patch remain unchanged.

Historical caching evidence remains in the unchanged
[September 7 investigation](../2026-09-07-claude-quota.md). No new quota/cache parity
claim is inferred from that evidence or synthetic token counters.


## Final acceptance and limitations

[Prefix results](prefix-checks.json) retain six real-binary cases. The corrected
current Meridian 1.62.6 / Claude Code 2.1.215 passes streaming (eight requests)
and non-streaming (five requests), including parallel tools, Git edits and warm
continuations. The proposed 1.68.0 / 2.1.260 tuple fails both modes' strict
historical-message representation check. System/tool hashes stay stable, actual
client results are retained, and all six cases have zero hidden requests.

The first changed historical record is a system token-budget message whose
content changes from a text-block array to a string on resume. A diagnostic run
using **current Meridian with Claude 2.1.260** reproduces the difference, as does
new Meridian with its minimum supported Claude Code **2.1.257**. This associates
the observed representation change with the newer executable; it does **not**
prove that Anthropic's cache normalization treats those forms differently. We
neither normalize away the failing assertion nor claim a measured live cache
regression. The agreed strict gate is incomplete, so both Claude packages stay
at their corrected current versions. The candidate port is retained for future
verification, not selected for managed startup.

[Installed checks](installed-checks.json) cover the new independent versions and
reloading the previous exact versions with the sanitized personal configuration.
Both pass model/variant/prompt/permission preservation, disabled MCP handling,
image reference/quality/size/output-versioning, missing auth, and Cursor text/tool
stream duplicate handling. This establishes adapter rollback compatibility;
no personal installation was downgraded or restarted.

The rebuilt Bot image passed baked-code offline OAuth acceptance: six synthetic
chat requests, one image request and three coordinated refreshes across the
isolated host and two Bots, with internet disabled. It uses OpenCode 1.18.26 and
image plugin 0.1.12. No public image tag or release manifest was published.

Validation:

- Workspace lint, type checks and documentation validation passed.
- Production web/Electron build and bundle budgets passed (web-main gzip
  1,382,486 bytes against a 1,456,388-byte ceiling).
- UI: 3,580 tests passed. All 13 remaining fixture/runtime package groups passed;
  their commands' outcomes are retained in [package suites](package-suites.json).
- The first full web run passed 3,863 of 3,864 tests. Its shell-deadline test also
  failed alone: its generic helper used the installed app's heavy-check slot
  directory. The helper now supplies the existing disposable test directory
  factory; the guard itself is unchanged. The final complete web rerun passed
  **all 3,864 tests across 368 files**. All 101 final focused tests also passed.
- The full validation command remains blocked by two unchanged script process
  ownership/cleanup tests: macOS process inspection is denied in this execution
  environment. The script run passed 584 of 586 tests. Those protections were
  not bypassed, and the full command is not reported as passing.
- Native web/Electron launch and cleanup acceptance is unavailable under that
  same process-inspection prerequisite. Package/build tests are not substituted
  for native UI acceptance or signing evidence.

Personal config and all original working-tree agent prompt changes remain
untouched. Temporary Docker acceptance containers were removed by their runners, and both
local test image tags were removed after acceptance. Hash verification confirmed
all original packaged-agent files and the installed corrected Meridian bundle
remained unchanged; personal model settings and Claude prompt mode also matched
the inspected baseline.
No credentials, live provider payloads, user transcripts or secrets are included
in this audit.

## Follow-up: GPT-6 Astra medium image default

After the plugin upgrade, the user requested GPT-6 Astra with medium reasoning for image generation. The shared guarded source patch now applies this request default during managed host provisioning and Bot builds. It accepts only reviewed source, preserves package-manager cache hard links through atomic replacement, and rejects modified or partially patched files. Personal installed files were not edited.

The installed-plugin fixture passed using the actual 0.1.12 package, asserting Astra/medium requests plus reference, quality, size, PNG output, non-overwrite and missing-auth behavior. The focused patch/provisioning suite passed 32 tests, including incomplete-patch rejection and atomic failure recovery.

The separately authorized [live image acceptance](astra-image-live.json) sent exactly one request using existing access-only ChatGPT OAuth in memory, received HTTP 200, and saved a valid 787,054-byte PNG. Visual inspection confirmed the requested blue circle on white. The backend returned 1254 × 1254 pixels despite the forwarded 1024 × 1024 size request; no exact-size guarantee is inferred. No credential refresh or Claude request occurred. This live check supersedes only the earlier image fixture-only coverage; the Claude upgrade remains held.

The production web/Electron builds, bundle budgets, lint, type checks and documentation checks passed. The first broad script run found the placeholder package fixture needed an injected image-patch stub; this was corrected in the fixture only. An unrelated bootstrap timing assertion failed under the concurrent build load and passed in the 22-test focused rerun.

The rebuilt [Bot image plugin check](astra-image-bot.json) passed offline at UID 10001, using the baked plugin to issue one synthetic Astra/medium request and save the exact returned PNG. Its first direct invocation failed because the disposable tmpfs belonged to root; rerunning with uid/gid 10001 fixed the fixture without changing production code. The broader three-runtime OAuth smoke timed out twice on its initial GPT-5.4 chats, before image execution, so coordinated OAuth acceptance is not claimed for this follow-up. No timeout or production guard was weakened.

Final full validation rerun: workspace lint, type checks, documentation, all 586 script tests, fixture/runtime package suites and all 3,580 UI tests passed. Web passed 3,869 of 3,870 tests across 369 files; the unchanged Cursor duplicate-tool-update timing test observed only the running event instead of running/completed, alongside a temporary-state ENOENT diagnostic. That single test passed when rerun in isolation (58 other cases skipped). The full gate is therefore **not** reported as passing. No Cursor implementation or assertions were changed in this image-model task.

The scoped Docker test image and acceptance containers were removed. The generated sample and safe local logs remain under repository `.cache/plugin-upgrades/2026-09-08/`; no live credential, refresh token, provider response body or personal configuration was written to the repository.
