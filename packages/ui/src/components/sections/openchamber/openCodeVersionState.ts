export type OpenCodeVersionViewStatus =
  | 'idle'
  | 'checking'
  | 'updateAvailable'
  | 'upToDate'
  | 'newerThanLatest'
  | 'currentUnavailable'
  | 'error';

type OpenCodeVersionViewState = {
  checked: boolean;
  checking: boolean;
  error: string | null;
  currentVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean | null;
};

export const resolveOpenCodeVersionViewStatus = (
  state: OpenCodeVersionViewState,
): OpenCodeVersionViewStatus => {
  if (state.checking) return 'checking';
  if (state.error) return 'error';
  if (!state.checked) return 'idle';
  if (!state.currentVersion) return 'currentUnavailable';
  if (state.updateAvailable) return 'updateAvailable';
  if (state.currentVersion === state.latestVersion) return 'upToDate';
  return 'newerThanLatest';
};
