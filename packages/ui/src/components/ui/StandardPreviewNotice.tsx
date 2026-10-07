import React from 'react';
import { toast } from '@/components/ui';
import { useStandardPreview } from '@/lib/opencode/runtime-capabilities';

export const STANDARD_PREVIEW_NOTICE = 'Experimental Standard Preview runs with ordinary user permissions. API-key coding chats, projects and file operations are available. Protected Revert/Redo and captured file history, managed child tasks, native provider transports and OAuth, Bots, browser and media helpers, and the integrated terminal are unavailable.';

export const StandardPreviewNotice: React.FC = () => {
  const preview = useStandardPreview();
  React.useEffect(() => {
    if (!preview) return;
    toast.warning('Experimental Standard Preview', {
      id: 'devryan-standard-preview', description: STANDARD_PREVIEW_NOTICE, duration: Infinity,
    });
    return () => { toast.dismiss('devryan-standard-preview'); };
  }, [preview]);
  return null;
};
