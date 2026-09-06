import { getSafeStorage } from '@/stores/utils/safeStorage';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import type { AuthPrincipal } from '@/lib/authSession';

const normalizeManagedDirectory = (value: string | null | undefined): string | null => {
  const input = typeof value === 'string' ? value.trim().replace(/\\/g, '/') : '';
  if (!input.startsWith('/')) {
    return null;
  }

  const segments: string[] = [];
  for (const segment of input.split('/')) {
    if (!segment || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (segments.length === 0) {
        return null;
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  return `/${segments.join('/')}`;
};

export const resolvePersistedDirectoryForPrincipal = (
  savedDirectory: string | null,
  principal?: AuthPrincipal,
): string | null => {
  if (principal?.scope !== 'managed' || principal.role === 'admin') {
    return savedDirectory;
  }

  const assignments = principal.assignments
    .map((assignment) => ({
      assignment,
      publicDirectory: normalizeManagedDirectory(assignment.publicDirectory),
    }))
    .filter((entry): entry is typeof entry & { publicDirectory: string } => Boolean(entry.publicDirectory));
  const normalizedSavedDirectory = normalizeManagedDirectory(savedDirectory);

  if (normalizedSavedDirectory && assignments.some(({ publicDirectory }) => (
    normalizedSavedDirectory === publicDirectory
    || normalizedSavedDirectory.startsWith(`${publicDirectory}/`)
  ))) {
    return normalizedSavedDirectory;
  }

  const defaultAssignment = assignments.find(({ assignment }) => assignment.isDefault) || assignments[0];
  return defaultAssignment?.publicDirectory ?? null;
};

export const applyPersistedDirectoryPreferences = (principal?: AuthPrincipal): void => {
  if (typeof window === 'undefined') {
    return;
  }

  let savedHome: string | null = null;
  let savedDirectory: string | null = null;

  try {
    savedHome = getSafeStorage().getItem('homeDirectory');
    savedDirectory = getSafeStorage().getItem('lastDirectory');
  } catch (error) {
    console.warn('Failed to read saved directory preferences:', error);
  }

  const directoryStore = useDirectoryStore.getState();

  const resolvedDirectory = resolvePersistedDirectoryForPrincipal(savedDirectory, principal);
  if (principal?.scope === 'managed' && principal.role !== 'admin') {
    if (!resolvedDirectory) {
      getSafeStorage().removeItem('lastDirectory');
      getSafeStorage().removeItem('homeDirectory');
      return;
    }

    // A managed principal's assignment is authoritative. Replace stale host
    // paths synchronously before App mounts and starts directory-bound effects.
    getSafeStorage().setItem('homeDirectory', resolvedDirectory);
    directoryStore.synchronizeHomeDirectory(resolvedDirectory);
    directoryStore.setDirectory(resolvedDirectory, { showOverlay: false });
    return;
  }

  if (savedHome && directoryStore.homeDirectory !== savedHome) {
    directoryStore.synchronizeHomeDirectory(savedHome);
  }

  if (resolvedDirectory) {
    directoryStore.setDirectory(resolvedDirectory, { showOverlay: false });
    return;
  }

  void directoryStore.refreshHomeDirectory();
};
