import type { UsageResetCredits, UsageWindow, UsageSourceMetadata } from '@/types';

export interface RateLimitGroup extends UsageSourceMetadata {
  providerId: string;
  providerName: string;
  entries: Array<[string, UsageWindow]>;
  error?: string;
  warnings?: string[];
  usageUpdatedAt?: number | null;
  resetCredits?: UsageResetCredits | null;
  modelFamilies?: Array<{
    familyId: string | null;
    familyLabel: string;
    models: Array<{
      modelName: string;
      label: string;
      window: UsageWindow;
      displayLabel: string;
    }>;
  }>;
}
