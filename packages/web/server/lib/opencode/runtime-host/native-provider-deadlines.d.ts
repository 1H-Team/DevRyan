export const NATIVE_PROVIDER_DEADLINES: Readonly<{ headerTimeout: number; chunkTimeout: number }>;
export function nativeProviderDeadlines(id: string, settings?: Record<string, unknown>): Record<string, unknown>;
