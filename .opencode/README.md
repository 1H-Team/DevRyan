# DevRyan project configuration

The maintained standard agent roles come from `packages/web/server/default-config/agents`.
Do not copy those prompts into this project's `agents` directory: project Markdown
overrides the packaged prompt, including its managed-task and recovery contracts.
Project-specific contributor guidance belongs in the repository's `AGENTS.md`.
Distinct custom roles may still live in `agents`.

Model and thinking selections remain owned by the user's DevRyan/Slim settings.
The removed stock prompt copies carried older fallback model names; they did not
define the effective personal selections and remain recoverable from Git history.
This migration does not change the project's provider, MCP, or LSP configuration.

The legacy project auto-resume plugin is retained for standalone OpenCode use.
It must defer whenever a DevRyan managed bridge is configured. Managed child
execution, result collection, and recovery belong to the DevRyan runtime.
