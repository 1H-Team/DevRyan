import React from 'react';
import { RiFileImageLine } from '@remixicon/react';

import type { ContentChangeReason } from '@/hooks/useChatAutoFollow';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import type { ToolPopupContent } from '../types';
import {
    buildGeneratedImageRawUrl,
    type GeneratedImageResult as GeneratedImageResultRecord,
} from './generatedImageResults';

interface GeneratedImageResultProps {
    result: GeneratedImageResultRecord;
    directory?: string;
    onShowPopup?: (content: ToolPopupContent) => void;
    onContentChange?: (reason?: ContentChangeReason) => void;
}

const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const GeneratedImageResult: React.FC<GeneratedImageResultProps> = ({
    result,
    directory,
    onShowPopup,
    onContentChange,
}) => {
    const { t } = useI18n();
    const runtime = React.useContext(RuntimeAPIContext);
    const [preview, setPreview] = React.useState<{ url: string; mimeType: string; size: number } | null>(null);
    const [failed, setFailed] = React.useState(false);

    React.useEffect(() => {
        const controller = new AbortController();
        let objectUrl: string | null = null;
        setPreview(null);
        setFailed(false);

        void fetch(buildGeneratedImageRawUrl(result.path, directory), {
            cache: 'no-store',
            signal: controller.signal,
        }).then(async (response) => {
            const mimeType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() || '';
            if (!response.ok || !mimeType.startsWith('image/')) {
                throw new Error(`Generated image preview failed with status ${response.status}`);
            }
            const blob = await response.blob();
            if (controller.signal.aborted) return;
            objectUrl = URL.createObjectURL(blob);
            setPreview({ url: objectUrl, mimeType, size: blob.size });
            onContentChange?.('structural');
        }).catch((error) => {
            if (controller.signal.aborted) return;
            console.warn('Unable to load generated image preview:', error);
            setFailed(true);
            onContentChange?.('structural');
        });

        return () => {
            controller.abort();
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
    }, [directory, onContentChange, result.path]);

    const caption = result.linkLabel || result.filename;
    const openPreview = React.useCallback(() => {
        if (!preview || !onShowPopup) return;
        onShowPopup({
            open: true,
            title: result.filename,
            content: '',
            metadata: { tool: 'gpt_imagegen', path: result.path },
            image: {
                url: preview.url,
                mimeType: preview.mimeType,
                filename: result.filename,
                size: preview.size,
            },
        });
    }, [onShowPopup, preview, result.filename, result.path]);

    if (failed) {
        const content = (
            <>
                <RiFileImageLine className="h-5 w-5 flex-shrink-0 text-muted-foreground" />
                <span className="min-w-0">
                    <span className="block truncate typography-meta text-foreground">{caption}</span>
                    <span className="block typography-micro text-muted-foreground">{t('chat.generatedImage.previewUnavailable')}</span>
                </span>
            </>
        );
        const className = 'inline-flex min-w-0 items-center gap-2 rounded-lg border border-border/40 bg-muted/10 px-3 py-2 text-left hover:bg-muted/20';
        return runtime?.editor ? (
            <button type="button" className={className} onClick={() => void runtime.editor?.openFile(result.path)}>
                {content}
            </button>
        ) : (
            <a href={buildGeneratedImageRawUrl(result.path, directory)} target="_blank" rel="noopener noreferrer" className={className}>
                {content}
            </a>
        );
    }

    if (!preview) {
        return (
            <div className="aspect-video w-full max-w-2xl animate-pulse rounded-xl border border-border/40 bg-muted/20" aria-label={t('chat.generatedImage.loading')} />
        );
    }

    return (
        <figure className="w-full max-w-2xl overflow-hidden rounded-xl border border-border/40 bg-muted/10">
            <button
                type="button"
                onClick={openPreview}
                disabled={!onShowPopup}
                className={cn(
                    'block w-full overflow-hidden bg-muted/10 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary',
                    onShowPopup && 'cursor-zoom-in',
                )}
                aria-label={t('chat.generatedImage.openPreview', { name: result.filename })}
            >
                <img
                    src={preview.url}
                    alt={caption}
                    className="max-h-[70vh] w-full object-contain"
                    loading="lazy"
                    onLoad={() => onContentChange?.('structural')}
                />
            </button>
            <figcaption className="flex items-center justify-between gap-3 border-t border-border/30 px-3 py-2">
                <span className="min-w-0 truncate typography-meta text-foreground" title={result.filename}>{caption}</span>
                <span className="flex-shrink-0 typography-micro text-muted-foreground">{formatFileSize(preview.size)}</span>
            </figcaption>
        </figure>
    );
};

export default React.memo(GeneratedImageResult);
