import type { Model } from '@opencode/core/model';
import type { Provider } from '@opencode/core/provider';
export interface NativeOpenAiModelPolicy { readonly oauth: boolean; readonly compactionReserved?: number }
export function nativeEncodableModels(models: readonly Model.Info[]): readonly Model.Info[];
export function normalizeNativeOpenAiModels(models: readonly Model.Info[], policy: NativeOpenAiModelPolicy): readonly Model.Info[];
export function normalizeNativeOpenAiRequest(model: Model.Info, settings: Provider.Settings | undefined, headers: Readonly<Record<string,string>>, policy: Pick<NativeOpenAiModelPolicy,'oauth'>): {settings:Provider.Settings | undefined;headers:Readonly<Record<string,string>>};
export function nativeCopilotModelsFromAccount(rows: unknown, existing: readonly Model.Info[]): readonly Model.Info[];
