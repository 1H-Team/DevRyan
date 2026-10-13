# xAI usage on app launch

The quota endpoint now renews a rejected xAI access token through the native controller and retries usage once. Renewal uses the registered xAI device implementation, the existing credential queue, original caller authorization, and selected credential identity/fingerprint. Refresh tokens stay inside the controller. Account switches, replacements, revoked authority and closed acquisitions cannot commit stale renewal results. Failed inspection retains credentials and reports either temporary unavailability or reconnect guidance.

## Verification

[Sanitized evidence](evidence.json) records the compiled native build, bundle check, 30 native credential tests and isolated web/Electron checks. Both renderer runs passed all 11 checks, including xAI usage fetched before the first prompt. Their synthetic usage transport verifies startup and rendering; the native tests exercise the actual registered xAI refresher, original caller grant, reverse queue, credential persistence, concurrent chat/usage renewal and refusal paths. All five screenshots from each successful run were inspected; the retained [web](web-xai-startup.png) and [Electron](electron-xai-startup.png) views show xAI usage. Both fixture journals passed gap verification with no gap records.

The first Electron attempt reached native readiness but failed because the private launcher app path pointed at the QA script folder, making the production preload unavailable. The launcher now selects the Electron package before importing its host; its regression test passed and the retry passed. The first full-validation attempt found change-related type errors, which were corrected. The final `bun run validate:full` passed workspace lint, type checks, documentation validation and all deterministic suites, including 4,120 UI tests, 6,712 web tests and 14 additional native host tests. The final QA harness tests also passed (five tests). `bun run build`, native compilation, Electron web-asset staging and `bun run bundle:check` passed.

## Limits and cleanup

No personal provider account, installed app state, password, or upstream checkout was accessed. The original incident journal was unavailable within the authorized repository. Live xAI acceptance was not run; permanently rejected refresh authorization still requires reconnecting. QA processes and their runtime payloads were cleaned by their runners. Task-owned retained QA and native build artifacts were removed after copying the sanitized evidence. Cache reporting and a prune preview completed; no unrelated cache cleanup was applied.
