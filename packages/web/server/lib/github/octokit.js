import { getGitHubAuth, isGhCliDisabled } from './auth.js';
import { getGhCliToken } from './gh-cli-credential.js';
import { createGitHubApiClient } from './api-client.js';

export function getOctokitOrNull() {
  const auth = getGitHubAuth();
  const token = auth?.accessToken || (!isGhCliDisabled() ? getGhCliToken() : null);
  if (!token) {
    return null;
  }
  return createGitHubApiClient({ auth: token });
}
