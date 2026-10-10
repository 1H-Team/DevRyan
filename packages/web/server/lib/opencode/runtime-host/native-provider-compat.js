import { isDeepStrictEqual } from 'node:util';
import { Model } from '@opencode/core/model';
import { Provider } from '@opencode/core/provider';
import { Result, Schema } from 'effect';
import { nativeCatalogSchemaPaths } from './native-catalog-diagnostics.js';

/** Refuse individual unencodable rows before policy reads or the HTTP encoder sees them. */
export function nativeEncodableModels(models) {
  const accepted = models.filter((model, index) => {
    const result = Schema.encodeUnknownResult(Model.Info)(model);
    if (Result.isSuccess(result)) {
      try { JSON.stringify(result.success); return true; } catch { /* Non-JSON plugin settings. */ }
    }
    const paths = Result.isFailure(result) ? nativeCatalogSchemaPaths(result.failure) : [];
    for (const field of paths.length ? paths : ['']) console.error(`level=warn msg=model_response_schema_invalid name=SchemaError schemaPath=[${index}]${field ? '.' + field : ''}`);
    return false;
  });
  return accepted.length === models.length ? models : accepted;
}
import { normalizeOpenAIModels, enforceDetailedOpenAIReasoningSummary, openAIModelHeaders } from '../../../default-config/plugins/openai-gpt-5-6-models.mjs';
import { selectGitHubCopilotRemoteModels } from '../../../default-config/plugins/github-copilot-models.mjs';

const legacyModel = model => ({ ...model, api: { id: model.modelID }, options: model.settings,
  variants: Object.fromEntries(model.variants.map(variant => [variant.id, variant.settings ?? {}])) });
const restoreModel = (source, normalized) => {
  const variants = Object.entries(normalized.variants ?? {}).map(([id, settings]) => ({
    ...source.variants.find(variant => variant.id === id), id, settings,
  }));
  const next = Schema.decodeUnknownSync(Schema.toType(Model.Info))({ ...source, settings: normalized.options,
    variants, limit: normalized.limit });
  return isDeepStrictEqual(source, next) ? source : next;
};

/** Data-only catalog policy. OAuth selection comes from the current native Integration acquisition. */
export function normalizeNativeOpenAiModels(models, { oauth, compactionReserved } = {}) {
  const original = models.map(model => Schema.decodeUnknownSync(Schema.toType(Model.Info))(model));
  const openai = original.filter(model => model.providerID === 'openai');
  const normalized = normalizeOpenAIModels(Object.fromEntries(openai.map(model => [model.id, legacyModel(model)])), { oauth, compactionReserved });
  const result = original.flatMap((model, index) => model.providerID !== 'openai' ? [models[index]]
    : normalized[model.id] ? [restoreModel(models[index], normalized[model.id])] : []);
  return result.length === models.length && result.every((model, index) => model === models[index]) ? models : result;
}

/** Preserve final model-request policy without granting provider or credential access. */
export function normalizeNativeOpenAiRequest(model, settings, headers, { oauth } = {}) {
  const native = Schema.decodeUnknownSync(Schema.toType(Model.Info))(model), legacy = legacyModel(native);
  const output = { options: settings };
  enforceDetailedOpenAIReasoningSummary({ model: legacy }, output);
  const additions = openAIModelHeaders(legacy, oauth);
  return { settings: output.options, headers: Object.keys(additions).length ? { ...headers, ...additions } : headers };
}

/** Account rows are supplied by an independently authorized native discovery operation. */
export function nativeCopilotModelsFromAccount(rows, existing) {
  const source = existing.map(model => Schema.decodeUnknownSync(Schema.toType(Model.Info))(model));
  const selected = selectGitHubCopilotRemoteModels(rows, Object.fromEntries(source.map(model => [model.id, {
    ...legacyModel(model), api: { id: model.modelID, npm: model.package, url: model.settings?.baseURL },
  }])));
  return Object.entries(selected).map(([id, model]) => {
    const previous = source.find(candidate => candidate.id === id);
    const defaults = previous ?? Model.Info.default(Schema.decodeUnknownSync(Provider.ID)('github-copilot'), Schema.decodeUnknownSync(Model.ID)(id));
    return Schema.decodeUnknownSync(Schema.toType(Model.Info))({ ...defaults, id, modelID: model.api?.id ?? id,
      providerID: 'github-copilot', name: model.name ?? id, package: model.api?.npm ? `aisdk:${model.api.npm}` : defaults.package,
      settings: { ...defaults.settings, ...model.options, ...(model.api?.url ? { baseURL: model.api.url } : {}), ...(model.api?.endpoint ? { endpoint: model.api.endpoint } : {}) },
      variants: Object.entries(model.variants ?? {}).map(([variantID, settings]) => ({ id: variantID, settings })),
      limit: model.limit, capabilities: { ...defaults.capabilities, tools: model.capabilities?.toolcall ?? true,
        input: model.capabilities?.input ? Object.entries(model.capabilities.input).filter(([, enabled]) => enabled).map(([kind]) => kind) : defaults.capabilities.input,
        output: model.capabilities?.output ? Object.entries(model.capabilities.output).filter(([, enabled]) => enabled).map(([kind]) => kind) : defaults.capabilities.output } });
  });
}
