import type { UsageResetCredits, UsageWindow } from '@/types';

export interface RateLimitGroup {
  providerId: string;
  providerName: string;
  entries: Array<[string, UsageWindow]>;
  error?: string;
  warnings?: string[];
  usageUpdatedAt?: number | null;
  resetCredits?: UsageResetCredits;
  modelRows?: Array<{
    modelName: string;
    label: string;
    window: UsageWindow;
    displayLabel: string;
  }>;
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
