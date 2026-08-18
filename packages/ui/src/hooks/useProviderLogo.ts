import { useState, useCallback, useEffect } from 'react';

type LogoSource = 'local' | 'remote' | 'none';

interface UseProviderLogoReturn {
    src: string | null;
    onError: () => void;
    hasLogo: boolean;
}

const localLogoModules = import.meta.glob<string>('../assets/provider-logos/*.svg', {
    eager: true,
    import: 'default',
});

const LOCAL_PROVIDER_LOGO_MAP = new Map<string, string>();

const LOGO_ALIAS = new Map<string, string>([
    ['codex', 'openai'],
    ['chatgpt', 'openai'],
    ['anthropic', 'claude'],
    ['claude', 'claude'],
    ['anthropic-oauth', 'claude'],
    ['opencode-with-claude', 'claude'],
    ['cursor-acp', 'cursor'],
    ['gemini', 'google'],
    ['opencode-go', 'opencode'],
    ['opencodego', 'opencode'],
    ['evroc-ai', 'evroc'],
    ['evrocai', 'evroc'],
    ['ollama-cloud', 'ollama'],
]);

const CURSOR_LOGO_DATA_URI = `data:image/svg+xml,${encodeURIComponent(`
<svg height="1em" viewBox="0 0 1024 1024" width="1em" xmlns="http://www.w3.org/2000/svg">
  <title>Cursor</title>
  <path clip-rule="evenodd" d="M512 39c14 0 28 4 40 11l362 210c16 9 25 26 25 45v422c0 19-10 37-27 47L552 982c-25 15-56 15-81 0L111 774c-17-10-27-28-27-47V305c0-19 10-36 26-45L472 50c12-7 26-11 40-11Zm-343 239c-22 0-30 29-10 39l330 165v401c0 28 38 37 52 13l331-586c8-15-3-32-20-32H169Z" fill="#000" fill-rule="evenodd"/>
</svg>
`)}`;

const normalizeProviderId = (providerId: string | null | undefined) => {
    return (providerId ?? '')
        .toLowerCase()
        .trim()
        .replace(/^models\./, '')
        .replace(/^provider\./, '')
        .replace(/\s+/g, '-');
};

const buildLogoCandidates = (providerId: string | null | undefined) => {
    const normalized = normalizeProviderId(providerId);
    if (!normalized) {
        return [] as string[];
    }

    const compact = normalized.replace(/[^a-z0-9_\-./:]/g, '');
    const primary = compact.split(/[/:]/)[0] || compact;
    const candidates = [LOGO_ALIAS.get(compact), LOGO_ALIAS.get(primary), compact, primary]
        .filter((value): value is string => Boolean(value && value.length > 0));

    return [...new Set(candidates)];
};

for (const [path, url] of Object.entries(localLogoModules)) {
    const match = path.match(/provider-logos\/([^/]+)\.svg$/i);
    if (match?.[1] && url) {
        LOCAL_PROVIDER_LOGO_MAP.set(match[1].toLowerCase(), url);
    }
}

export function useProviderLogo(providerId: string | null | undefined): UseProviderLogoReturn {
    const candidates = buildLogoCandidates(providerId);
    const isCursorLogo = candidates.includes('cursor');
    const localResolvedId = candidates.find((candidate) => LOCAL_PROVIDER_LOGO_MAP.has(candidate)) ?? null;
    const remoteResolvedId = candidates[0] ?? null;
    const hasLocalLogo = Boolean(localResolvedId);
    const localLogoSrc = localResolvedId ? LOCAL_PROVIDER_LOGO_MAP.get(localResolvedId) ?? null : null;

    const [source, setSource] = useState<LogoSource>(isCursorLogo || hasLocalLogo ? 'local' : 'remote');

    useEffect(() => {
        setSource(isCursorLogo || hasLocalLogo ? 'local' : 'remote');
    }, [hasLocalLogo, isCursorLogo, localResolvedId, remoteResolvedId]);

    const handleError = useCallback(() => {
        setSource((current) => (current === 'local' && hasLocalLogo && !isCursorLogo ? 'remote' : 'none'));
    }, [hasLocalLogo, isCursorLogo]);

    if (isCursorLogo && source === 'local') {
        return {
            src: CURSOR_LOGO_DATA_URI,
            onError: handleError,
            hasLogo: true,
        };
    }

    if (!localResolvedId && !remoteResolvedId) {
        return { src: null, onError: handleError, hasLogo: false };
    }

    if (source === 'local' && localLogoSrc) {
        return {
            src: localLogoSrc,
            onError: handleError,
            hasLogo: true,
        };
    }

    if (source === 'remote' && remoteResolvedId) {
        return {
            src: `https://models.dev/logos/${remoteResolvedId}.svg`,
            onError: handleError,
            hasLogo: true,
        };
    }

    return { src: null, onError: handleError, hasLogo: false };
}
