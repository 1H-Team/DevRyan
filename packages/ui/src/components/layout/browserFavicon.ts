const MAX_FAVICON_URL_LENGTH = 32_768;

export const sanitizeBrowserFaviconUrl = (value: unknown): string | undefined => {
  const faviconUrl = typeof value === 'string'
    ? value.trim().slice(0, MAX_FAVICON_URL_LENGTH)
    : '';
  if (!faviconUrl) return undefined;
  if (faviconUrl.toLowerCase().startsWith('data:image/')) return faviconUrl;
  try {
    const parsed = new URL(faviconUrl);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? parsed.toString()
      : undefined;
  } catch {
    return undefined;
  }
};
