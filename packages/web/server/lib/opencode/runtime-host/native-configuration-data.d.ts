export const NATIVE_LOCATION_IDLE_TIMEOUT: string;
export function nativeModelSelection(model: unknown, variant?: unknown, hasVariant?: boolean): { providerID: string; model: string; variant?: string };
export function nativePermissionRules(input: unknown): readonly { action: string; resource: string; effect: string }[];
export function translateNativeConfiguration(input: { readonly legacy: Record<string, unknown>; readonly agents: Record<string, unknown>; readonly commands?: Record<string, unknown> }): Record<string, unknown>;
export const NATIVE_PROVIDER_DEADLINES: Readonly<{ headerTimeout: number; chunkTimeout: number }>;
export function nativeProviderDeadlines(id: string, settings?: Record<string, unknown>): Record<string, unknown>;
export function nativeProviderConfigurations(input: unknown): Record<string, unknown>;
