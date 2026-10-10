import { expect, test } from 'bun:test';
import { Cause, Effect, ErrorReporter, Schema } from 'effect';
import { HttpApiSchemaError } from 'effect/unstable/httpapi/HttpApiError';
import { HostRefusal, runWithHostRefusal } from '../../packages/web/server/lib/opencode/runtime-host/host-refusal.js';
import { createNativeCatalogDiagnostics, nativeCatalogCause, nativeCatalogSchemaPaths, withNativeCatalogStage } from '../../packages/web/server/lib/opencode/runtime-host/native-catalog-diagnostics.js';
import { assertNativeCatalog } from '../../packages/web/server/lib/opencode/runtime-host/startup-catalog.js';

test('SDK-caught model defects retain only this request recognized diagnostic', async () => {
  const inspect = (error?: Error) => assertNativeCatalog({ directories: ['/private/project'], requirements: { agents: [], plugins: [], tools: [], models: [] }, tools: async () => [],
    handler: async (request, context) => {
      if (new URL(request.url).pathname !== '/api/model') return Response.json({ location: { directory: '/private/project' }, data: [] });
      if (!context) throw new Error('Missing native report context');
      if (error) await Effect.runPromise(ErrorReporter.report(Cause.die(error)).pipe(Effect.provide(context)));
      await Promise.resolve();
      return Response.json({ message: 'private config secret', code: 'native_model_normalize_failed' }, { status: 500 });
    } });
  const outcomes = await Promise.allSettled([inspect(new HostRefusal('native_model_normalize_failed', 503, 'private secret /home')), inspect(), inspect(new Error('private secret')), inspect(new HostRefusal('native_openai_method_unsupported',503,'provider.openai'))]);
  expect(outcomes.map(row => row.status === 'rejected' ? row.reason.message : 'unexpected success')).toEqual([
    'native_catalog_read_failed_model_http_500_model_normalize_failed',
    'native_catalog_read_failed_model_http_500_cause_unavailable',
    'native_catalog_read_failed_model_http_500_cause_unavailable',
    'native_catalog_read_failed_model_http_500_openai_method_unsupported',
  ]);
});

test('native graph construction captures schema classification without retaining invalid values', async () => {
  const diagnostics = createNativeCatalogDiagnostics();
  const result = await Effect.runPromise(Effect.sync(() => Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))({ id: { token: 'private secret' } }))
    .pipe(Effect.onError(cause => Effect.sync(() => diagnostics.capture(cause))), Effect.provide(diagnostics.context), Effect.exit));
  expect(result._tag).toBe('Failure');
  expect(diagnostics.cause()).toBe('schema_invalid');
});

test('response encoding failures retain only fixed causes and schema field paths through wrappers', async () => {
  const encoded = await Effect.runPromise(HttpApiSchemaError.wrap('Body', Schema.encodeUnknownEffect(Schema.Struct({
    data: Schema.Array(Schema.Struct({ capabilities: Schema.Struct({ tools: Schema.Boolean }) })),
  }))({ data: [{ capabilities: { tools: 'private secret' } }] })).pipe(Effect.exit));
  expect(encoded._tag).toBe('Failure');
  if (encoded._tag !== 'Failure') throw new Error('Expected encoding failure');
  const reason = encoded.cause.reasons[0];
  if (reason._tag !== 'Fail') throw new Error('Expected HTTP schema error');
  const wrapped = new Error('private secret', { cause: reason.error });
  expect(nativeCatalogCause(wrapped)).toBe('response_schema_invalid');
  expect(nativeCatalogSchemaPaths(wrapped)).toEqual(['data.[0].capabilities.tools']);
  const diagnostics = createNativeCatalogDiagnostics(); diagnostics.capture(Cause.die(wrapped));
  expect(diagnostics.paths()).toEqual(['data.[0].capabilities.tools']);
  expect(JSON.stringify(diagnostics.paths())).not.toContain('private secret');
  const cycle = new Error('cycle'); cycle.cause = cycle;
  expect(nativeCatalogCause(cycle)).toBeUndefined();
  expect(nativeCatalogSchemaPaths(cycle)).toEqual([]);
  await expect(assertNativeCatalog({ directories: ['/private/project'], requirements: { agents: [], plugins: [], tools: [], models: [] }, tools: async () => [],
    handler: async (request, context) => {
      if (new URL(request.url).pathname !== '/api/model') return Response.json({ location: { directory: '/private/project' }, data: [] });
      await Effect.runPromise(ErrorReporter.report(encoded.cause).pipe(Effect.provide(context!)));
      return new Response(null, { status: 500 });
    } })).rejects.toThrow('native_catalog_read_failed_model_http_500_response_schema_invalid');
});

test('SDK-converted body errors retain whitelisted paths while malformed paths and values stay private', () => {
  const error = Object.assign(new Error('private value\n  at ["data"][7]["settings"]["private-secret"]'), { _tag: 'InvalidRequestError', kind: 'Body' });
  expect(nativeCatalogCause(error)).toBe('response_schema_invalid');
  expect(nativeCatalogSchemaPaths(error)).toEqual(['data.[7].settings.<key>']);
  error.message = 'private value\n  at ["data"]["\\q"]';
  expect(nativeCatalogSchemaPaths(error)).toEqual([]);
  error.kind = 'Payload';
  expect(nativeCatalogCause(error)).toBeUndefined();
});

test('construction-captured reporters route concurrent SDK errors to their active catalog request', async () => {
  const construction = createNativeCatalogDiagnostics();
  const inspect = (schema: boolean) => assertNativeCatalog({ directories: ['/private/project'], requirements: { agents: [], plugins: [], tools: [], models: [] }, tools: async () => [],
    handler: async request => {
      if (new URL(request.url).pathname !== '/api/model') return Response.json({ location: { directory: '/private/project' }, data: [] });
      await Promise.resolve();
      const error = schema ? Object.assign(new Error('private value\n  at ["data"][0]["time"]["released"]'), { _tag: 'InvalidRequestError', kind: 'Body' }) : new Error('private secret');
      await Effect.runPromise(ErrorReporter.report(Cause.fail(error)).pipe(Effect.provide(construction.context)));
      return new Response(null, { status: 500 });
    } });
  const outcomes = await Promise.allSettled([inspect(true), inspect(false)]);
  expect(outcomes.map(row => row.status === 'rejected' ? row.reason.message : '')).toEqual([
    'native_catalog_read_failed_model_http_500_response_schema_invalid', 'native_catalog_read_failed_model_http_500_cause_unavailable',
  ]);
  expect(construction.cause()).toBeUndefined();
});

test('fixed model stage refusals preserve deliberate denial and expired-owner codes', async () => {
  for (const code of ['native_catalog_file_invalid', 'native_model_build_failed', 'native_model_read_failed', 'native_model_account_failed', 'native_model_normalize_failed'] as const) {
    const result = await runWithHostRefusal(() => Effect.runPromise(withNativeCatalogStage(Effect.die(new Error('private config secret')), code)));
    expect(result).toMatchObject({ ok: false, refusal: { code, status: 503 } });
    expect(JSON.stringify(result)).not.toContain('private config secret');
  }
  const denial = new HostRefusal('native_helper_denied', 403, 'catalog.model');
  const result = await runWithHostRefusal(() => Effect.runPromise(withNativeCatalogStage(Effect.die(denial), 'native_model_read_failed')));
  expect(result).toEqual({ ok: false, refusal: denial });
  await expect(Effect.runPromise(withNativeCatalogStage(Effect.die(new Error('native_provider_location_expired')), 'native_model_read_failed'))).rejects.toThrow('native_provider_location_expired');
  const interruption = await Effect.runPromise(withNativeCatalogStage(Effect.interrupt, 'native_model_read_failed').pipe(Effect.exit));
  expect(interruption._tag).toBe('Failure');
  if (interruption._tag === 'Failure') expect(Cause.hasInterruptsOnly(interruption.cause)).toBe(true);
});
