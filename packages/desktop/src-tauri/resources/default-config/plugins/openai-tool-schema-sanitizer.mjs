// OpenAI tool-schema sanitizer (OpenChamber-bundled opencode plugin)
//
// Problem: OpenAI's strict function/tool JSON-schema validator rejects `pattern`
// regexes that use lookaround. Zod's `z.string().email()` (and similar) compiles
// to exactly such a pattern, and several MCP tools (resend, mercury, stripe,
// linear, …) ship those schemas. The result is that EVERY turn on the OpenAI
// provider (e.g. the default `gpt-5.5` orchestrator) fails before the model runs:
//
//   AI_APICallError: Invalid JSON schema: regex lookaround is not supported.
//                    Found at $.properties.email.pattern.
//
// Fix: via opencode's `tool.definition` hook, walk each tool's input schema and
// drop ONLY the `pattern` constraints that contain lookaround. Removing the regex
// hint does not change tool behaviour — the field still exists and is still typed;
// we only discard an unsupported *validation* constraint. Patterns without
// lookaround are left untouched, and providers that accept lookaround (Anthropic,
// Cursor, …) are unaffected because they never needed the constraint to begin with.

const LOOKAROUND = /\(\?[=!<]/;
const MAX_DEPTH = 64;

const stripLookaroundPatterns = (node, depth) => {
  if (!node || typeof node !== "object" || depth > MAX_DEPTH) return;

  if (Array.isArray(node)) {
    for (const item of node) stripLookaroundPatterns(item, depth + 1);
    return;
  }

  if (typeof node.pattern === "string" && LOOKAROUND.test(node.pattern)) {
    delete node.pattern;
  }

  for (const key of Object.keys(node)) {
    const value = node[key];
    if (value && typeof value === "object") stripLookaroundPatterns(value, depth + 1);
  }
};

export const OpenAiToolSchemaSanitizerPlugin = async () => {
  return {
    "tool.definition": async (_input, output) => {
      try {
        if (output && output.parameters) {
          stripLookaroundPatterns(output.parameters, 0);
        }
      } catch {
        // Never block a tool definition on sanitisation failure.
      }
    },
  };
};

export default OpenAiToolSchemaSanitizerPlugin;
