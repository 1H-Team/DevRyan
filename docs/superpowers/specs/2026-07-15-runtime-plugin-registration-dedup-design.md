# Runtime plugin registration deduplication

## Problem

Managed OpenCode loads the normal user/project configuration and DevRyan's generated high-precedence runtime overlay. The user profile registers the local Slim wrapper as `./plugins/devryan-oh-my-opencode-slim.mjs`, while the runtime overlay also copies and registers a packaged plugin with the same filename.

OpenCode resolves the two relative specs against different config directories before merging them, so they become distinct file URLs and both plugin instances load. The effective Test config exposed both the user-profile and generated-overlay wrapper URLs.

The broader Test workload catalog contained 285 advertised OpenAI tool schemas for only 150 unique IDs, but isolated after-fix measurement proved that most of that duplication has another source. This fix's causal share is four duplicate schemas (`ast_grep_replace`, `ast_grep_search`, `cancel_task`, and `webfetch`) and 4,043 serialized characters: OpenAI changes from 285 schemas / 270,507 characters to 281 / 266,464, while Anthropic, GitHub Copilot, and Google change from 288 / 272,966 to 284 / 268,923. The remaining repeated Railway/Resend and core schemas stay recorded as a separate audit finding.

## Source of truth

A configured local plugin path remains owned and loaded by the user or project config file that declared it. The runtime overlay only needs a packaged registration when no active local plugin with that packaged filename exists.

## Design

- Classify allowlisted active plugin entries as package specs or local filesystem specs.
- Keep forwarding allowlisted package specs into the runtime overlay; exact package identities already merge safely.
- Do not restate an active local filesystem spec in the generated overlay.
- Suppress a packaged plugin registration when an active local filesystem plugin has the same filename.
- Continue materializing packaged plugin files. If the source entry is removed, the next overlay sync can register the already managed packaged fallback.
- Leave unrelated active and packaged plugins unchanged.

## Rejected alternatives

- Always remove the packaged Slim wrapper: this loses the fallback for configurations without the source entry.
- Resolve the source entry into an absolute file URL inside the overlay: the merged config does not retain enough origin information to do this safely for user and project layers.
- Deduplicate tool schemas after discovery: duplicate plugin hooks would still execute, and policy belongs at plugin registration rather than the presentation endpoint.

## Safety properties

- Each source-configured local plugin executes once.
- Packaged runtime plugins without a source-owned equivalent remain registered.
- Removing the source entry restores the packaged registration on the next sync.
- Provider/model selection and provider-specific schema handling are unchanged.

## Verification

- Add a regression that combines an active local Slim wrapper with the same packaged filename and proves the overlay omits the duplicate registration.
- Prove the packaged file remains materialized and becomes registered after the source entry is removed.
- Re-run the actual tool-catalog probe across configured providers and compare total/unique schema counts and serialized size without attributing unrelated duplicates to this registration fix.
- Exercise the affected DevRyan UI journey and confirm one effective wrapper registration with no loading or layout regressions.
