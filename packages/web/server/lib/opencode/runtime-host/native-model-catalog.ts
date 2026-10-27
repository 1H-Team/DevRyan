import { Effect, Layer } from 'effect';
import { ModelsDev } from '@opencode/core/models-dev';
import { nativeCatalogStageFailure, withNativeCatalogStage } from './native-catalog-diagnostics.js';
import catalogFile from '../../../../runtime/reviewed-inputs/model-catalog/DevRyan-model-catalog.json' with { type: 'file' };
// TypeScript's JSON resolver describes the data; Bun's file loader returns its
// owned path. Validate that boundary instead of casting away the difference.
const catalogPath: unknown = catalogFile;

/** Use the original native parser with immutable reviewed data embedded by Bun.
 * Explicit file mode skips KV; neither SDK snapshot nor HTTP is a fallback. */
export function nativeModelCatalogOverride() {
  if (typeof catalogPath !== 'string') throw new Error('native_catalog_file_invalid');
  return ModelsDev.node.replace(ModelsDev.configured({ file: catalogPath, fetch: false, snapshot: false }).mapLayer(inner => {
    const reviewed = inner.pipe(Layer.catchCause(cause => Layer.effect(ModelsDev.Service, nativeCatalogStageFailure(cause, 'native_catalog_file_invalid'))));
    return Layer.effect(ModelsDev.Service, Effect.gen(function* () {
      const catalog = yield* ModelsDev.Service;
      return {
        get: () => withNativeCatalogStage(catalog.get().pipe(Effect.flatMap(rows => rows.some(provider => provider.models.length > 0)
          ? Effect.succeed(rows) : Effect.die(new Error('native_catalog_file_invalid')))), 'native_catalog_file_invalid'),
        refresh: () => Effect.die(new Error('native_catalog_refresh_disabled')),
      };
    })).pipe(Layer.provide(reviewed));
  }));
}
