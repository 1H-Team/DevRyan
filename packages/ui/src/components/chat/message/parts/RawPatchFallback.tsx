import React from 'react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { getToolDiffPreview } from './toolDiffPreview';
import { downloadToolDiffPatch } from './toolDiffDownload';

export const RawPatchFallback: React.FC<{
  patch: string;
  truncated?: boolean;
  getFullPatch?: () => string;
}> = ({ patch, truncated = false, getFullPatch }) => {
  const { t } = useI18n();
  const preview = React.useMemo(() => getToolDiffPreview(patch), [patch]);
  const isTruncated = truncated || preview.truncated;
  const download = () => {
    try {
      downloadToolDiffPatch(getFullPatch ? getFullPatch() : patch);
    } catch {
      toast.error(t('chat.toolPart.diffDownloadFailed'));
    }
  };
  return (
    <div data-tool-diff-truncated={isTruncated ? 'true' : undefined}>
      {isTruncated ? (
        <div className="flex flex-wrap items-center gap-2 px-2 py-1 typography-meta text-muted-foreground">
          <span>{t('chat.toolPart.diffPreviewTruncated')}</span>
          <Button variant="ghost" size="sm" onClick={download}>{t('chat.toolPart.downloadFullPatch')}</Button>
        </div>
      ) : null}
      <pre className="tool-output-surface m-0 rounded-lg p-2 whitespace-pre-wrap break-words typography-code text-muted-foreground/90">{preview.text}</pre>
    </div>
  );
};
