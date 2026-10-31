// Integrations DevRyan connects through its own dedicated scopes, never the generic provider one,
// and `anthropic`, whose saved selections run through claude-agent (`nativeModelSelection`).
const DELEGATED = new Set(['openai', 'cursor-acp', 'claude-agent', 'anthropic']);
const ID = /^[A-Za-z0-9_-]{1,256}$/;
// OpenCode names every remote MCP OAuth integration `mcp_<sha1 prefix>`.
const MCP = /^mcp_[0-9a-f]{16}$/;

/**
 * A model provider integration connected through the generic `provider` scope: any
 * OpenCode integration other than the delegated ones and MCP servers. Keys are
 * accepted for all of them; OAuth only for methods the controller registered from a
 * reviewed native provider plugin (`controller-provider-credentials.ts`).
 */
export const isCatalogProviderIntegration = value => typeof value === 'string' && ID.test(value) && !DELEGATED.has(value) && !MCP.test(value);

const FIELD_KEY = /^[A-Za-z0-9_.-]{1,64}$/;
/**
 * A provider method's form answer as Providers sends it (Azure resource name, GitHub
 * deployment type): at most 16 fields of short strings or booleans. The facade checks it
 * against the method's form; this is the shape every later hop accepts.
 */
export const isProviderFormAnswer = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length >= 1 && Object.keys(value).length <= 16 && Object.entries(value).every(([key, item]) => FIELD_KEY.test(key)
    && (typeof item === 'boolean' || typeof item === 'string' && item.length >= 1 && item.length <= 2048 && !item.includes('\0')));
