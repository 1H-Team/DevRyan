import { Context, Effect, ErrorReporter, Schema, type SchemaIssue, type Cause } from 'effect';
import { HttpApiSchemaError } from 'effect/unstable/httpapi/HttpApiError';
import { AsyncLocalStorage } from 'node:async_hooks';
import { sanitizeNativeSchemaPath } from '@openchamber/harness-runtime/lib/sanitizer.js';
import { HostRefusal, refuseHost } from './host-refusal.js';

const causes = new Map([
  ['native_helper_directory_denied', 'helper_directory_denied'],
  ['native_helper_denied', 'helper_denied'],
  ['native_helper_timeout_invalid', 'helper_timeout_invalid'],
  ['controller_helper_denied', 'controller_helper_denied'],
  ['controller_helper_unavailable', 'controller_helper_unavailable'],
  ['mutation_runtime_unsupported', 'mutation_runtime_unsupported'],
  ['native_catalog_unavailable', 'catalog_unavailable'],
  ['native_catalog_file_invalid', 'catalog_file_invalid'],
  ['native_model_build_failed', 'model_build_failed'],
  ['native_model_read_failed', 'model_read_failed'],
  ['native_model_account_failed', 'model_account_failed'],
  ['native_model_normalize_failed', 'model_normalize_failed'],
  ['native_provider_location_required', 'provider_location_required'],
  ['native_provider_location_expired', 'provider_location_expired'],
  ['native_openai_method_unsupported', 'openai_method_unsupported'],
]);
const catalogRequest = new AsyncLocalStorage<(cause: Cause.Cause<unknown>) => void>();
const responseSchemaError = (error: object) => HttpApiSchemaError.is(error) && error.kind === 'Body'
  || '_tag' in error && error._tag === 'InvalidRequestError' && 'kind' in error && error.kind === 'Body';
const pathKey = (key: PropertyKey) => typeof key === 'number' && Number.isSafeInteger(key) && key >= 0 ? `[${key}]`
  : typeof key === 'string' && sanitizeNativeSchemaPath(key) ? key : '<key>';

export const nativeCatalogCause = (error: unknown): string | undefined => {
  const seen = new Set<unknown>();
  while (error && typeof error === 'object' && !seen.has(error) && seen.size < 16) {
    seen.add(error);
    if (responseSchemaError(error)) return 'response_schema_invalid';
    if (error instanceof HostRefusal) return causes.get(error.code);
    if (Schema.isSchemaError(error)) return 'schema_invalid';
    if (error instanceof Error && causes.has(error.message)) return causes.get(error.message);
    error = 'cause' in error ? error.cause : undefined;
  }
  return undefined;
};

export function nativeCatalogSchemaPaths(error: unknown): readonly string[] {
  const seen = new Set<unknown>();
  while (error && typeof error === 'object' && !seen.has(error) && seen.size < 16) {
    seen.add(error);
    // The SDK schema-error middleware discards the original issue tree. Parse only
    // formatter path lines and whitelist their keys; never retain its reason text.
    if (responseSchemaError(error) && !HttpApiSchemaError.is(error) && 'message' in error && typeof error.message === 'string') {
      const paths: string[] = [];
      for (const line of error.message.slice(0, 4096).split('\n')) {
        const path = /^\s+at (\[.*\])$/.exec(line)?.[1];
        if (!path || paths.length >= 8) continue;
        const tokens = [...path.matchAll(/\[(\d+|"(?:[^"\\]|\\.)*")\]/g)];
        if (tokens.map(token => token[0]).join('') !== path) continue;
        try {
          paths.push(tokens.map(token => {
            const key: unknown = JSON.parse(token[1]);
            return typeof key === 'number' || typeof key === 'string' ? pathKey(key) : '<key>';
          }).join('.').slice(0, 256));
        } catch { /* Malformed formatter paths are not diagnostic evidence. */ }
      }
      return [...new Set(paths)];
    }
    if (Schema.isSchemaError(error)) {
      const paths: string[] = [];
      const walk = (issue: SchemaIssue.Issue, path: readonly PropertyKey[], depth: number) => {
        if (depth > 32 || paths.length >= 8) return;
        if (issue._tag === 'Pointer') walk(issue.issue, [...path, ...issue.path], depth + 1);
        else if ('issues' in issue) for (const nested of issue.issues) walk(nested, path, depth + 1);
        else if ('issue' in issue) walk(issue.issue, path, depth + 1);
        else paths.push(path.map(pathKey).join('.').slice(0, 256));
      };
      walk(error.issue, [], 0);
      return [...new Set(paths)];
    }
    error = 'cause' in error ? error.cause : undefined;
  }
  return [];
}

/** One construction/read scope; SDK-caught defects never retain raw messages or stacks. */
export function createNativeCatalogDiagnostics() {
  let cause: string | undefined;
  let paths: readonly string[] = [];
  const capture = (reported: Cause.Cause<unknown>) => {
    for (const reason of reported.reasons) {
      const recognized = nativeCatalogCause(reason._tag === 'Fail' ? reason.error : reason._tag === 'Die' ? reason.defect : undefined);
      if (recognized) { if (!cause) { cause = recognized; paths = nativeCatalogSchemaPaths(reason._tag === 'Fail' ? reason.error : reason._tag === 'Die' ? reason.defect : undefined); } break; }
    }
  };
  // SDK endpoints capture construction context; direct its reporter to the active request.
  const reporter = ErrorReporter.make(({ cause: reported }) => (catalogRequest.getStore() ?? capture)(reported));
  return { context: Context.make(ErrorReporter.CurrentErrorReporters, new Set([reporter])), capture, cause: () => cause, paths: () => paths,
    run: <A>(work: () => Promise<A>) => catalogRequest.run(capture, work) };
}

export type NativeCatalogStageCode = 'native_catalog_file_invalid' | 'native_model_build_failed'
  | 'native_model_read_failed' | 'native_model_account_failed' | 'native_model_normalize_failed';

/** Keep deliberate host refusals; replace arbitrary native defects with a fixed stage. */
export function nativeCatalogStageFailure(cause: Cause.Cause<unknown>, code: NativeCatalogStageCode): Effect.Effect<never> {
  if (cause.reasons.every(reason => reason._tag === 'Interrupt')) return Effect.interrupt;
  for (const reason of cause.reasons) {
    const error = reason._tag === 'Fail' ? reason.error : reason._tag === 'Die' ? reason.defect : undefined;
    if (error instanceof HostRefusal) return refuseHost(error);
    if (error instanceof Error && causes.has(error.message)) return Effect.die(error);
  }
  return refuseHost(new HostRefusal(code, 503, 'catalog.model'));
}

export const withNativeCatalogStage = <A, E, R>(effect: Effect.Effect<A, E, R>, code: NativeCatalogStageCode): Effect.Effect<A, never, R> =>
  effect.pipe(Effect.catchCause(cause => nativeCatalogStageFailure(cause, code)));
