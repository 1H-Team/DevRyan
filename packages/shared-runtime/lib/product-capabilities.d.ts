export const BOTS_ENABLED: boolean;
export const BOTS_RETIRED: Readonly<{ code: 'bots_retired'; error: string }>;
export function assertBotsEnabled(): void;
