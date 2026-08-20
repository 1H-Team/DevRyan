const COLOR_PRESERVING_PROVIDER_IDS = new Set([
    'anthropic',
    'anthropic-oauth',
    'claude',
    'opencode-with-claude',
]);

export const shouldPreserveProviderLogoColor = (providerId: string | null | undefined): boolean => {
    const normalized = (providerId ?? '')
        .toLowerCase()
        .trim()
        .replace(/^models\./, '')
        .replace(/^provider\./, '');
    const primary = normalized.split(/[/:]/)[0] || normalized;

    return COLOR_PRESERVING_PROVIDER_IDS.has(normalized)
        || COLOR_PRESERVING_PROVIDER_IDS.has(primary);
};
