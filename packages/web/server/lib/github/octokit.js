import { getGitHubAuth, getGitHubAuthById, isGhCliDisabled } from './auth.js';
import { getGhCliToken } from './gh-cli-credential.js';
import { createGitHubApiClient } from './api-client.js';
import { getRequestPrincipal } from '../multi-user/request-context.js';

export function getOctokitForAccount(accountId) {
  const auth = getGitHubAuthById(accountId);
  return auth?.accessToken ? createGitHubApiClient({ auth: auth.accessToken }) : null;
}

/**
 * Resolves the request's stored account and its client from one auth read, so
 * a route that later keys caches or permission checks by the account uses the
 * same credential its client was built from. `auth` is null for the gh CLI
 * fallback, which has no stored account identity.
 */
export function getGitHubClientSnapshot() {
  const principal = getRequestPrincipal();
  if (principal?.scope === 'managed') {
    const accountId = principal.githubAccountId || null;
    const auth = accountId ? getGitHubAuthById(accountId) : null;
    return auth?.accessToken
      ? { auth, octokit: createGitHubApiClient({ auth: auth.accessToken }) }
      : { auth: null, octokit: null };
  }
  const auth = getGitHubAuth();
  if (auth?.accessToken) {
    return { auth, octokit: createGitHubApiClient({ auth: auth.accessToken }) };
  }
  const token = !isGhCliDisabled() ? getGhCliToken() : null;
  return token
    ? { auth: null, octokit: createGitHubApiClient({ auth: token }) }
    : { auth: null, octokit: null };
}

export function getOctokitOrNull() {
  return getGitHubClientSnapshot().octokit;
}
