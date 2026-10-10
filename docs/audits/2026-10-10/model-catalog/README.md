# Model catalog incident repair — 2026-10-10

The installed startup failure is **reproduced and repaired in isolation**. The
exact selected controller returns
`native_catalog_read_failed_model_http_500_cause_unavailable` when its active
OpenAI credential uses the retired `chatgpt-browser` method. Changing only that
method to `chatgpt-siwc` makes the same synthetic configuration start. With the
new diagnostics and the repair omitted, the failure is
`native_catalog_read_failed_model_http_500_openai_method_unsupported`. With the
repair, startup succeeds. The complete sanitized 282-model fixture also starts
with all seven registered plugin IDs and all five active integration shapes,
including the expired xAI device login. The final packaged artifact also passed
this complete native startup fixture. See [actual-cause.json](actual-cause.json).

Authorized read-only metadata inspection identified the retired method without
reading credential secrets, prompts or messages. The selected journal has zero
gaps. The active project has no startup config overrides. All reproductions use
synthetic databases and sanitized configuration inside the repository; the
installed app, selector, database and configuration remain untouched.

The root cause is a catalog connection refusing retired OpenAI authentication,
not a demonstrated model response-encoding error. The native adapter now returns
an unavailable connection for `chatgpt-browser`, `chatgpt-headless` and
`chatgpt-token-sharing` during catalog reads. It neither refreshes nor rewrites
these credentials. Physical requests still refuse them before acquiring access.
The user must reconnect OpenAI through Sign in with ChatGPT before using that
provider; a retired login no longer prevents the app from starting.

The real cold-controller graph starts with a synthetic browser OAuth record and
NULL connector/method columns and requires model HTTP 200 in both locations.
Focused tests require unchanged credential records, zero access acquisitions and
`native_openai_method_unsupported` on physical requests for all three retired
methods. Unknown unsupported methods receive the fixed catalog diagnostic.

Cold startup now compares selected and shipped artifact digests at the same
OpenCode version. The existing verified clone, credential checkpoint and selector
CAS activate repaired host code once and retain the old bundle for rollback.
Identical artifacts skip copying; an explicit same-version rollback stays
selected. This is local runtime preparation and performs no app update discovery.

The permanent schema diagnostics and per-model encoding guard remain defensive
coverage. The encoding regression produces a real SDK HTTP 400 without the guard
and HTTP 200 with it; it is independent of the reproduced HTTP 500. Controller
stderr stays memory-only, bounded to 4 KiB, with only sanitized recognized fields
and safe schema paths entering the journal. Raw messages, values and stacks do
not become diagnostic evidence.

Startup no longer waits for optional agent/chat warmup or prewarms every saved
project. Optional warmup starts after usable UI; automatic update discovery first
runs at the normal one-hour interval. Manual checks remain available. The native
owner performs launch verification once before managed config synchronization;
boot hands fresh checked artifacts privately to its loader. Reviewed executable
config bytes and immediate pre-spawn artifact verification remain checked.

The [matched packaged comparison](startup-comparison.json) passed all three fresh
process/profile launches in each cohort. Median spawn-to-usable-chat time fell
from **13.914 seconds to 13.343 seconds**: **0.572 seconds, or 4.1%**. Each candidate
launch was faster than its corresponding baseline launch. Both cohorts use the
same sanitized 282-model Cursor/Anthropic shapes, synthetic retired OpenAI login,
local model transport and owned foreground activation, on identical OpenCode
2.0.26 core bytes. The baseline retains its recorded prior UI policy and duplicate
verification; the candidate uses the consolidated checks and optimized UI policy.
All supplied models survived, Composer 2.5 appeared in the picker, and candidate
startup made zero update checks with optional warmup after usable UI.

This is a modest measured improvement, not a claim about natural foreground
admission, cold OS caches or the installed database. Timing fixtures use empty
plugin/MCP configuration and synthetic model defaults; all seven registered
plugin IDs and all five active integration shapes are covered separately by the
native startup proof. The
[first UI-policy comparison](startup-first-comparison.json) did not show an
improvement. A [catalog-concurrency experiment](startup-parallel-comparison.json)
also did not improve total time and was removed.

The [packaged repair delivery check](packaged-repair-upgrade.json) passed three
fresh production app-bound upgrades from the exact selected artifact digest
`504ac9c1c97469d2205bf9e4fffca1dbc5e5e37d033431f574e437b80f9a9110`
to the packaged repaired artifact. Each committed one selector revision and
retained its old bundle for rollback. These first repair launches took a median
**31.332 seconds**, including local copying and credential checkpointing; they
are separate from the subsequent prepared-bundle timing above. No deferred
OpenCode startup failure occurred, the provider catalog returned HTTP 200 with
all 282 models, and the picker worked. See [repaired picker](repaired-model-picker.png)
and [upgrade picker](upgrade-model-picker.png).

The [final full validation](final-verification.json) passed, including 4,076 UI
tests, 6,560 web tests and the native graph checks. Build, bundle checks, focused
lifecycle/bundle/native tests and packaged verification have passed. The
baseline UI policy comes from the recorded Git HEAD sources without replacing
working-tree files; its package/source identities are retained in the proof.
Prior [packaged-startup.json](packaged-startup.json), [startup-before.json](startup-before.json)
and [verification.json](verification.json) retain historical attempts and do not
establish this controlled comparison. No release or installed-app update has
been performed.
