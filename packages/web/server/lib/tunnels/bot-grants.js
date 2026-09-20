export const isBotTunnelPrincipal = (principal) => principal?.scope === 'tunnel-bot';
export const hasTunnelBotGrant = (principal, botId) => !isBotTunnelPrincipal(principal)
  || (principal.tunnelGrant?.expiresAt > Date.now() && principal.tunnelGrant.botIds.includes(botId));

// Default deny. Adding a Bot route does not silently expose it remotely. Record
// authorization still checks membership/channel ACL after this transport gate.
const ID = '[a-fA-F0-9-]{36}';
const VIEW = 'view_[A-Za-z0-9_-]{24}';
const rules = [
  ['GET', '/api/bots(?:/capabilities|/assigned|/events)?'],
  ['GET', `/api/bots/${ID}(?:/avatar|/computer/status|/computer/view/${VIEW}/stream)?`],
  ['POST', `/api/bots/${ID}/(?:channel|computer/view|computer/control/(?:take|heartbeat|return|command))`],
  ['DELETE', `/api/bots/${ID}/computer/view/${VIEW}`],
  ['GET', `/api/bots/${ID}/(?:channels/${ID}/shared-files|objects/${ID})`],
  ['POST', `/api/bots/${ID}/channels/${ID}/objects`],
  ['GET', `/api/bot-channels/${ID}/messages`],
  ['POST', `/api/bot-channels/${ID}/(?:messages|prewarm)`],
  ['DELETE', `/api/bot-channels/${ID}(?:/prewarm/${ID})?`],
  ['GET', `/api/bot-runs/${ID}/status`],
  ['POST', `/api/bot-runs/${ID}/(?:cancel|retry)`],
  ['GET', `/api/bot-actions/(?:pending|${ID}|${ID}/evidence/${ID})`],
  ['POST', `/api/bot-actions/${ID}/decision`],
].map(([method, pattern]) => [method, new RegExp(`^${pattern}/?$`)]);

export function isBotTunnelRoute(req) {
  const pathname = (req.originalUrl || req.url || '').split('?')[0];
  // Reject encodings and ambiguous path normalization before Express routers.
  if (pathname.includes('%') || pathname.includes('\\') || pathname.includes('//')) return false;
  return rules.some(([method, pattern]) => req.method === method && pattern.test(pathname));
}

export function assertTunnelBotGrant(principal, botId, operation = null) {
  if (!isBotTunnelPrincipal(principal)) return;
  if (!hasTunnelBotGrant(principal, botId) || (operation && !['read_channel', 'send_channel', 'operate_bot'].includes(operation))) {
    throw Object.assign(new Error('This tunnel link does not grant this Bot operation'), { code: 'tunnel_bot_forbidden', statusCode: 403 });
  }
}
