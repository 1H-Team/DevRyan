import { getGitHubAuth, getGitHubAuthById, isGhCliDisabled } from './auth.js';
import { getGhCliToken } from './gh-cli-credential.js';
import { createGitHubApiClient } from './api-client.js';
import { getRequestPrincipal } from '../multi-user/request-context.js';

export function getOctokitForAccount(accountId) {
  const auth = getGitHubAuthById(accountId);
  return auth?.accessToken ? createGitHubApiClient({ auth: auth.accessToken }) : null;
}

export function getOctokitOrNull() {
  const principal = getRequestPrincipal();
  if (principal?.scope === 'managed') {
    const accountId = principal.githubAccountId || null;
    return accountId ? getOctokitForAccount(accountId) : null;
  }
  const auth = getGitHubAuth();
  const token = auth?.accessToken || (!isGhCliDisabled() ? getGhCliToken() : null);
  if (!token) {
    return null;
  }
  return createGitHubApiClient({ auth: token });
}
