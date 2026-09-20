export interface EfficiencyRoute {
  id: string; provider: string; model: string; auth: string; transport: string; origin: string; path: string;
  experiments?: { titleEffort?: boolean; conversationAffinity?: boolean };
  qualification?: { source: 'final_wire'; evidence: 'live' | 'fixture'; allAttemptsObserved: boolean; runtimeVersion: string;
    id: string; provider: string; model: string; auth: string; transport: string; origin: string; path: string;
    responseModel?: string; baselineEffort?: string; redirectsBlocked?: boolean; verifiedTitleEfforts?: string[] };
}
export interface EfficiencySelection { provider: string; model: string; runtimeVersion: string; variants?: Record<string, Record<string, unknown>>; sessionID?: string }
export function isLoopbackCacheOrigin(origin: string): boolean;
export function qualifiedEfficiencyRoute(route: EfficiencyRoute, selection: EfficiencySelection): boolean;
export function selectTitleEfficiencyVariant(route: EfficiencyRoute, selection: EfficiencySelection): { variant: string; options: { reasoningEffort: string } } | null;
export function conversationAffinityControl(route: EfficiencyRoute, selection: EfficiencySelection): 'x-grok-conv-id' | 'prompt_cache_key' | null;
