export const NATIVE_PROVIDER_DEADLINES: Readonly<{ headerTimeout: number; chunkTimeout: number }>;
export function nativeProviderDeadlines(id: string, settings?: Record<string, unknown>): Record<string, unknown> | undefined;
export function withNativeProviderDeadlines<Provider extends { readonly settings?: Record<string, unknown> }>(id: string, provider: Provider): Provider;
export function nativeRequestHeaderDeadline(providerID: string, configured: unknown, coreDefault: number): number | undefined;
export const NATIVE_DEADLINE_EXEMPT_PROVIDERS: readonly string[];
