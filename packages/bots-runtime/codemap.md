# packages/bots-runtime/

## Responsibility

Dependency-free, JSON-only policy contracts shared by every Production Bots host. This package owns stable enums, bounded duplicate-key-rejecting JSON, scope derivation, canonical hashing, legacy/v3 revision rules, structured matcher/quota bindings, transcript authorization, approval eligibility, run/action state transitions, computer-lease admission, and missed-routine recovery.

## Entry points

- `index.js` / `index.d.ts`: complete public JavaScript and TypeScript surface.
- `contract.js`: strict JSON boundary primitives, public enums/error codes, canonical JSON/SHA-256, and reasoning/computer scope keys.
- `strict-json.js`: bounded textual JSON parser that rejects duplicate object
  keys before portable-spec verification.
- `lifecycle.js`: Bot lifecycle graph and immutable activated-revision policy.
- `policy.js`: channel ACL/member decisions, approval classes, and exact action hashing.
- `run-state.js`: run/action transition graphs including durable `waiting_control`, unknown-write classification, and one-lease admission.
- `routines.js`: missed-run defaults and bounded recovery occurrence selection.
- `opencode/devryan-bot-tools.mjs`: capability-bound private gateway plugin for
  governed memory, Library, computer/action, explicit Shared publication, and
  isolated workspace operations, plus OAuth-capability-gated delegation to the
  pinned ChatGPT image-generation plugin.
- `docker/opencode/`: pinned non-root OpenCode image and serve entrypoint for a
  server-compiled read-only runtime config. `launch-opencode.mjs` imports the
  fixed per-run environment JSON without shell evaluation; the legacy
  initializer remains a fixture-only image command.
- `opencode/oauth.integration.mjs` / `oauth-fixture.mjs`: disposable Docker acceptance with no internet, fixture TLS/OAuth/provider endpoints, managed host plus two Bot processes, forced refreshes and the real pinned image plugin. No production login, container or image tag is modified.

## Invariants

1. Object-taking public functions reject missing and unknown fields.
2. Canonical inputs are plain JSON data: no accessors, prototypes, non-finite numbers, sparse arrays, symbols, `undefined`, or cycles.
3. Production computer scope is per Bot; the personalized form remains legacy
   contract compatibility only, and reasoning scope is always per channel.
4. Activated revision content and terminal run/action state cannot be reopened through these contracts.
5. An executing write interrupted without a receipt becomes `unknown`, never an automatically retryable failure.
6. A live computer-scope lease admits only its owning run.
7. Primary-agent `devryan_image` exists only for a server-derived OpenAI ChatGPT
   OAuth capability and reuses the pinned plugin schema. The legacy
   `image.generate` executor remains compatible but unadvertised; credentials
   never become a tool argument.
8. Environment variables enter only from the fixed read-only per-run JSON and
   are inherited by reasoning children, never the computer runtime.
9. Legacy revisions resolve to OpenCode/matcher v1 without hash rewriting;
   revision v3 pins OpenCode or AG-UI, structured matcher v2, public-only or
   exact-host browser policy, and standard/runsc isolation.

## Integration

Server and Electron adapters consume this package instead of duplicating policy. UI clients consume the enums and error codes but keep live Bot projections in Bot-only stores. Validation treats a package change as affecting Bots, web, Electron, and UI.

The server compiles runtime config, Electron verifies it, and the Docker
supervisor mounts it read-only for `serve`. The plugin derives
run/channel/revision identity only from the injected capability.
Autonomous revisions may enable scoped file/shell/terminal/Git tools and only
the non-recursive `explore`/`general` subagents; raw browser/CDP, direct MCP,
Docker, host orchestration/credentials, and external directories stay denied.
