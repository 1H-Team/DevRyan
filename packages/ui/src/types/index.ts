import type { Session, Message, Part, Provider } from "@opencode-ai/sdk/v2";

export type { Session, Message, Part, Provider };
export type {
  UsageSourceMetadata,
  QuotaProviderId,
  UsageWindow,
  UsageWindows,
  UsageResetCredit,
  UsageResetCredits,
  ProviderUsage,
  ProviderResult
} from './quota';

export interface ModelMetadata {
  id: string;
  providerId: string;
  name?: string;
  tool_call?: boolean;
  reasoning?: boolean;
  temperature?: boolean;
  attachment?: boolean;
  modalities?: {
    input?: string[];
    output?: string[];
  };
  cost?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
  };
  limit?: {
    context?: number;
    output?: number;
  };
  knowledge?: string;
  release_date?: string;
  last_updated?: string;
}
