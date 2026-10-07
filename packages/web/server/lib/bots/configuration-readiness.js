// Resolve retained configuration references against this host. An import does
// not rewrite signed contracts or fetch skill/Library payloads to hide gaps.
export const CONFIGURATION_RESOURCE_COLUMNS = Object.freeze({
  bot_skill_packages: ['id', 'bot_id', 'package_digest'],
  bot_library_versions: ['id', 'source_id'],
  bot_library_sources: ['id', 'bot_id', 'retired_at'],
  bot_mcp_bindings: ['id', 'bot_id', 'descriptor_digest', 'manifest_digest', 'display_metadata', 'credential_provider'],
  bot_credentials: ['id', 'bot_id', 'status', 'revoked_at', 'provider', 'credential_scope', 'owner_user_id'],
  bot_agent_connections: ['id', 'bot_id', 'descriptor_digest', 'status', 'credential_id', 'auth_mode'],
  bot_environment_secrets: ['id', 'bot_id', 'status'],
});

export async function configurationResourceBlockers({ botId, contract, get, environmentSecrets = [], credentials = [],
  ownerUserId = null, checkModelCredentials = true }) {
  const blockers = [];
  const missing = (kind, resourceId) => blockers.push({ botId, kind, resourceId });
  for (const binding of contract?.skillBindings || []) {
    const row = await get('bot_skill_packages', binding.id);
    if (!row || row.bot_id !== botId || row.package_digest !== binding.digest) missing('skill', binding.id);
  }
  for (const id of contract?.libraryVersionIds || []) {
    const version = await get('bot_library_versions', id);
    const source = version ? await get('bot_library_sources', version.source_id) : null;
    if (!version || !source || source.bot_id !== botId || source.retired_at) missing('library', id);
  }
  for (const binding of contract?.mcpBindings || []) {
    const row = await get('bot_mcp_bindings', binding.id);
    if (!row || row.bot_id !== botId || row.descriptor_digest !== binding.descriptorDigest
      || row.manifest_digest !== binding.manifestDigest) missing('mcp', binding.id);
    else if (row.display_metadata?.credentialRequired === true && !credentials.some((credential) => (
      credential.bot_id === botId && credential.provider === row.credential_provider
      && credential.status === 'active' && !credential.revoked_at
      && ((credential.credential_scope === 'team' && credential.owner_user_id === null)
        || (ownerUserId && credential.credential_scope === 'user' && credential.owner_user_id === ownerUserId))
    ))) missing('mcp-credential', binding.id);
  }
  const models = contract?.agent?.kind === 'opencode' ? contract.agent.models : contract?.models;
  const credentialIds = new Set((checkModelCredentials ? [models?.primary, ...(models?.fallbacks || [])] : [])
    .map((model) => model?.credentialId).filter(Boolean));
  if (contract?.agent?.kind === 'ag_ui') {
    const row = await get('bot_agent_connections', contract.agent.connectionRef);
    if (!row || row.bot_id !== botId || row.status !== 'active'
      || row.descriptor_digest !== contract.agent.connectionDigest) missing('agent', contract.agent.connectionRef);
    if (row?.auth_mode === 'bearer' && row.credential_id) credentialIds.add(row.credential_id);
  }
  for (const id of credentialIds) {
    const row = await get('bot_credentials', id);
    if (!row || row.bot_id !== botId || row.status !== 'active' || row.revoked_at) missing('credential', id);
  }
  for (const row of environmentSecrets) {
    if (row.bot_id === botId && row.status === 'error') missing('environment', row.id);
  }
  return blockers;
}
