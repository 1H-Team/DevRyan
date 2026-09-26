import React from 'react';

import { toast } from '@/components/ui';
import { useConfigStore } from '@/stores/useConfigStore';

type ProfileNotice = {
  code: string;
  files: string[];
  message: string;
};

const isProfileNotice = (value: unknown): value is ProfileNotice => {
  if (!value || typeof value !== 'object') return false;
  const notice = value as Record<string, unknown>;
  return typeof notice.code === 'string'
    && typeof notice.message === 'string'
    && Array.isArray(notice.files)
    && notice.files.every((file) => typeof file === 'string');
};

const readProfileNotices = async (): Promise<ProfileNotice[]> => {
  const response = await fetch('/health', { method: 'GET', cache: 'no-store' });
  if (!response.ok) return [];
  const health = await response.json() as { openCodeProfileNotices?: unknown };
  return Array.isArray(health.openCodeProfileNotices)
    ? health.openCodeProfileNotices.filter(isProfileNotice)
    : [];
};

const retireLegacyCursorPlugin = async (): Promise<void> => {
  const response = await fetch('/api/config/legacy-cursor-plugin/retire', { method: 'POST' });
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  if (!response.ok) {
    throw new Error(typeof body?.error === 'string' ? body.error : `Request failed (${response.status})`);
  }
};

const LEGACY_CURSOR_TOAST_ID = 'opencode-legacy-cursor-plugin';

// Startup no longer blocks on profile cleanup it cannot finish safely. The
// notice is read once each time initialization completes (startup and every
// OpenCode restart) and stays until the user acts on it.
export const OpenCodeProfileNotices: React.FC = () => {
  const isInitialized = useConfigStore((state) => state.isInitialized);

  React.useEffect(() => {
    if (!isInitialized) return;
    let cancelled = false;

    const retire = async () => {
      try {
        await retireLegacyCursorPlugin();
        toast.dismiss(LEGACY_CURSOR_TOAST_ID);
        toast.success('Legacy Cursor plugin retired', {
          description: 'A backup was kept. OpenCode restarts once active chats finish.',
        });
      } catch (error) {
        toast.error('Could not retire the legacy Cursor plugin', {
          description: error instanceof Error ? error.message : String(error),
        });
      }
    };

    void readProfileNotices()
      .then((notices) => {
        if (cancelled) return;
        const notice = notices.find((entry) => entry.code === 'legacy_cursor_plugin_conflict');
        if (!notice) {
          toast.dismiss(LEGACY_CURSOR_TOAST_ID);
          return;
        }
        toast.warning('Legacy Cursor plugin still active', {
          id: LEGACY_CURSOR_TOAST_ID,
          description: `${notice.message}${notice.files.length > 0 ? ` ${notice.files.join(', ')}` : ''}`,
          duration: Infinity,
          action: {
            label: 'Retire Plugin',
            onClick: () => { void retire(); },
          },
        });
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [isInitialized]);

  return null;
};
