const TOKEN_PATTERN = /^eyJ[A-Za-z0-9_-]{40,}={0,2}$/;
const ERROR_MESSAGE = 'Paste a raw Cloudflare tunnel token or a Cloudflare-generated connector command.';

export class ManagedRemoteTunnelTokenValidationError extends Error {
  constructor() {
    super(ERROR_MESSAGE);
    this.name = 'ManagedRemoteTunnelTokenValidationError';
  }
}

const unquote = (value) => {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

export const normalizeManagedRemoteTunnelToken = (value) => {
  const input = typeof value === 'string' ? value.trim() : '';
  if (TOKEN_PATTERN.test(input)) return input;

  const serviceMatch = input.match(/^(?:sudo\s+)?cloudflared(?:\.exe)?\s+service\s+install\s+(["']?[^\s"']+["']?)$/i);
  if (serviceMatch) {
    const token = unquote(serviceMatch[1]);
    if (TOKEN_PATTERN.test(token)) return token;
    throw new ManagedRemoteTunnelTokenValidationError();
  }

  const tokenArgumentCount = [...input.matchAll(/(?:^|\s)--token(?==|\s|$)/g)].length;
  if (tokenArgumentCount !== 1) throw new ManagedRemoteTunnelTokenValidationError();

  const connectorMatch = input.match(/^(?:(?:brew\s+install\s+cloudflared\s+&&\s+)?(?:sudo\s+)?cloudflared(?:\.exe)?\s+tunnel\s+run|docker\s+run\s+cloudflare\/cloudflared(?::[^\s]+)?\s+tunnel(?:\s+--no-autoupdate)?\s+run)\s+--token(?:=|\s+)(["']?[^\s"']+["']?)$/i);
  if (connectorMatch) {
    const token = unquote(connectorMatch[1]);
    if (TOKEN_PATTERN.test(token)) return token;
  }
  throw new ManagedRemoteTunnelTokenValidationError();
};
