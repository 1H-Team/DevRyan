// Route-specific experiments are disabled unless a caller supplies both an
// explicit flag and matching final-wire qualification. No provider defaults.
export function isLoopbackCacheOrigin(origin) {
  try {
    const host = new URL(origin).hostname.toLowerCase().replace(/\.$/, '');
    return ['localhost', '[::1]', '[::]', '0.0.0.0'].includes(host) || /^127\.\d+\.\d+\.\d+$/.test(host)
      || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(host);
  } catch { return false; }
}
export function qualifiedEfficiencyRoute(route, selection) {
  const proof = route?.qualification;
  if (!proof || proof.source !== 'final_wire' || proof.allAttemptsObserved !== true
    || proof.evidence !== 'live' || !proof.runtimeVersion) return false;
  let endpoint;
  try { endpoint = new URL(route.origin); } catch { return false; }
  if (endpoint.protocol !== 'https:' || endpoint.origin !== route.origin || endpoint.username || endpoint.password
    || isLoopbackCacheOrigin(route.origin)
    || !route.path?.startsWith('/')) return false;
  return ['id', 'provider', 'model', 'auth', 'transport', 'origin', 'path'].every(key => route[key] === proof[key])
    && route.provider === selection.provider && route.model === selection.model
    && proof.runtimeVersion === selection.runtimeVersion;
}

export function selectTitleEfficiencyVariant(route, selection) {
  if (route?.experiments?.titleEffort !== true || route.provider !== 'xai' || !qualifiedEfficiencyRoute(route, selection)) return null;
  const advertised = selection.variants;
  const ordered = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
  const lowest = ordered.find(effort => Object.hasOwn(advertised ?? {}, effort));
  if (!lowest || !route.qualification.verifiedTitleEfforts?.includes(lowest)) return null;
  // Only forward the advertised option; never invent a model-specific control.
  const options = advertised[lowest];
  if (options?.reasoningEffort !== lowest || Object.keys(options).some(key => key !== 'reasoningEffort')) return null;
  return { variant: lowest, options: { reasoningEffort: lowest } };
}

export function conversationAffinityControl(route, selection) {
  if (route?.experiments?.conversationAffinity !== true || route.provider !== 'xai'
    || !qualifiedEfficiencyRoute(route, selection) || !selection.sessionID) return null;
  return route.transport === 'chat_completions' ? 'x-grok-conv-id'
    : route.transport === 'responses' ? 'prompt_cache_key' : null;
}
