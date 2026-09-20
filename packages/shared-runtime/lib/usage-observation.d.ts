export type UsageSource = 'provider_request' | 'runtime_step' | 'message_aggregate';
export type UsagePurpose = 'main' | 'title' | 'compaction' | 'commit' | 'pr' | 'other_helper' | 'unknown';
export interface UsageTokens {
  totalInput: number | null; uncachedInput: number | null; cacheRead: number | null; cacheWrite: number | null;
  cacheWrite5m: number | null; cacheWrite1h: number | null; cacheWrite30m: number | null;
  output: number | null; reasoning: number | null; totalOutput: number | null;
}
export interface UsageSemantics { input: 'inclusive' | 'uncached' | 'unknown'; output: 'inclusive' | 'exclusive' | 'unknown' }
export interface UsageCost { amount: number | null; currency: 'USD' | null; provenance: 'provider_billed' | 'runtime_reported' | 'api_price_equivalent' | 'unknown' }
export interface UsageTimestamp { at: number | null; origin: 'client_wire' | 'runtime' | 'native' | 'unknown' }
export interface UsageObservationV1 {
  version: 1; source: UsageSource; observationID: string;
  rootTaskID: string | null; rootSessionID: string | null; sessionID: string | null;
  messageID: string | null; parentMessageID: string | null; stepID: string | null; attemptID: string | null; responseID: string | null;
  counterScopeID: string | null; provider: string | null; route: string | null; runtimeVersion: string | null;
  requestedModel: string | null; responseModel: string | null; purpose: UsagePurpose;
  auth: 'api_key' | 'oauth' | 'unknown'; transport: 'responses' | 'chat_completions' | 'messages' | 'native' | 'unknown';
  status: 'dispatched' | 'complete' | 'failed' | 'aborted' | 'unknown'; use: 'first' | 'warm' | 'unknown';
  counterMode: 'delta' | 'cumulative'; cumulativeFromZero: boolean; sequence: number | null;
  observedAt: number | null; tokens: UsageTokens; semantics: UsageSemantics; cost: UsageCost;
  timing: Record<'dispatch' | 'firstToken' | 'completion' | 'previousCompletion', UsageTimestamp>;
}
export const USAGE_TOKEN_FIELDS: readonly (keyof UsageTokens)[];
export function normalizeUsageTokens(raw?: Record<string, unknown>, semantics?: Partial<UsageSemantics>): UsageTokens;
export function projectUsageObservation(value: unknown): UsageObservationV1 | null;
export function normalizeUsageObservation(value: Record<string, unknown>): UsageObservationV1 | null;
export function runtimeUsageObservation(record: unknown): UsageObservationV1 | null;
export function nativeClaudeUsageObservation(message: unknown, context?: Record<string, unknown>): UsageObservationV1 | null;
export function nativeCodexUsageObservation(usage: unknown, context?: Record<string, unknown>): UsageObservationV1 | null;
export function estimateApiEquivalent(tokens: UsageTokens, prices: Record<string, unknown>): UsageCost | null;
