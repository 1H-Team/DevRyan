import type { BotSharedFile } from '@/lib/botsApi';
import {
  canonicalizeAssistantImageSource,
  extractAssistantImageReferences,
} from '../../../../../shared-runtime/lib/assistant-image-sources.js';

export const BOT_PREVIEW_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

export type BotResultImageSource = Readonly<{
  key: string;
  alt: string;
  file: BotSharedFile | null;
  source: string | null;
}>;

export const resolveBotResultImageSources = (
  sharedFiles: readonly BotSharedFile[],
  text: string,
): BotResultImageSource[] => {
  const mappedPaths = new Set<string>();
  const results: BotResultImageSource[] = [];
  for (const file of sharedFiles) {
    if (file.direction !== 'bot' || !BOT_PREVIEW_IMAGE_TYPES.has(file.contentType.toLowerCase())) {
      continue;
    }
    mappedPaths.add(file.computerPath);
    results.push({ key: `object:${file.objectId}`, alt: file.filename, file, source: null });
  }
  for (const reference of extractAssistantImageReferences(text)) {
    const source = canonicalizeAssistantImageSource(reference.source);
    if (!source || mappedPaths.has(source) || (!source.startsWith('http') && !source.startsWith('data:'))) {
      continue;
    }
    results.push({
      key: `source:${source}`,
      alt: reference.caption || 'Generated image',
      file: null,
      source,
    });
  }
  return results.filter((image, index) => (
    results.findIndex((candidate) => candidate.key === image.key) === index
  ));
};
