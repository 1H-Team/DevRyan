import React from 'react';
import { RiImageLine, RiRefreshLine } from '@remixicon/react';
import { useShallow } from 'zustand/react/shallow';

import { Button } from '@/components/ui/button';
import { botsApi, type BotSharedFile } from '@/lib/botsApi';
import { cn } from '@/lib/utils';
import {
  useBotSharedFilesStore,
  type BotSharedFilesStore,
} from '@/stores/useBotSharedFilesStore';
import { createBotImagePreviewCache, verifyBotImageBlob } from './botImagePreviewCache';
import { resolveBotResultImageSources } from './botResultImageSources';

const previewCache = createBotImagePreviewCache();

const mark = (name: string): void => {
  try { performance.mark(name); } catch { /* Diagnostics must not affect rendering. */ }
};

type ResultImage = Readonly<{
  key: string;
  alt: string;
  expectedType?: string;
  load(signal: AbortSignal): Promise<Blob>;
}>;

const BotResultImage: React.FC<{ image: ResultImage }> = ({ image }) => {
  const targetRef = React.useRef<HTMLDivElement | null>(null);
  const [nearViewport, setNearViewport] = React.useState(typeof IntersectionObserver === 'undefined');
  const [attempt, setAttempt] = React.useState(0);
  const [state, setState] = React.useState<'loading' | 'ready' | 'error'>('loading');
  const [url, setUrl] = React.useState<string | null>(null);

  React.useEffect(() => {
    const target = targetRef.current;
    if (!target || typeof IntersectionObserver === 'undefined') {
      setNearViewport(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      setNearViewport(entry?.isIntersecting === true);
    }, { rootMargin: '640px 0px' });
    observer.observe(target);
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    if (!nearViewport) return;
    let active = true;
    setState('loading');
    setUrl(null);
    void previewCache.acquire(image.key, image.load, image.expectedType).then(async (nextUrl) => {
      mark('bot.image.preview-fetch');
      const decoded = new Image();
      decoded.src = nextUrl;
      await decoded.decode?.();
      if (!active) return;
      mark('bot.image.decoded');
      setUrl(nextUrl);
      setState('ready');
    }).catch(() => {
      if (active) setState('error');
    });
    return () => {
      active = false;
      previewCache.release(image.key);
    };
  }, [attempt, image, nearViewport]);

  return (
    <div
      ref={targetRef}
      className="relative mt-2 aspect-[4/3] w-full max-w-2xl overflow-hidden rounded-xl border border-border/60 bg-muted/30"
    >
      {state === 'ready' && url ? (
        <img src={url} alt={image.alt} className="h-full w-full object-contain" />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-muted-foreground">
          {state === 'error' ? (
            <Button size="sm" variant="outline" onClick={() => setAttempt((value) => value + 1)}>
              <RiRefreshLine className="mr-1.5 h-4 w-4" aria-hidden />
              Retry Image
            </Button>
          ) : (
            <RiImageLine className={cn('h-8 w-8', nearViewport && 'animate-pulse')} aria-label="Loading Image" />
          )}
        </div>
      )}
    </div>
  );
};

type BotResultAttachmentsProps = {
  botId: string;
  messageId: string;
  text: string;
  sharedFilesStore?: BotSharedFilesStore;
};

export const BotResultAttachments = React.memo<BotResultAttachmentsProps>(({
  botId,
  messageId,
  text,
  sharedFilesStore = useBotSharedFilesStore,
}) => {
  const sharedFiles = sharedFilesStore(useShallow((state) => (
    (state.fileIdsByMessageId[messageId] || []).map((id) => state.filesById[id]).filter(Boolean)
  )));
  const images = React.useMemo<ResultImage[]>(() => {
    return resolveBotResultImageSources(sharedFiles as BotSharedFile[], text).map((image) => ({
      key: image.key,
      alt: image.alt,
      ...(image.file ? {
        expectedType: image.file.contentType,
        load: (signal: AbortSignal) => botsApi.downloadObject(botId, image.file!.objectId, null, signal),
      } : {
        load: async (signal: AbortSignal) => verifyBotImageBlob(await fetch(image.source!, { signal }).then((response) => {
          if (!response.ok) throw new Error('image_fetch_failed');
          return response.blob();
        })),
      }),
    }));
  }, [botId, sharedFiles, text]);

  if (images.length === 0) return null;
  return <div aria-label="Bot Images">{images.map((image) => <BotResultImage key={image.key} image={image} />)}</div>;
});

BotResultAttachments.displayName = 'BotResultAttachments';
