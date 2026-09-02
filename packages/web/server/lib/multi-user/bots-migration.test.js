import { describe, expect, it } from 'vitest';

import {
  PRODUCTION_BOTS_MIGRATION,
  isMissingProductionBotsSchemaError,
  productionBotsMigrationFailurePayload,
} from './auth-compat.js';
import { SupabaseRequestError } from './supabase-client.js';

describe('Production Bots schema compatibility', () => {
  it('pins the complete schema migration identifier', () => {
    expect(PRODUCTION_BOTS_MIGRATION).toBe('20260902120000');
  });

  it('recognizes missing Bot relations from PostgREST and Postgres', () => {
    const schemaCacheMiss = new SupabaseRequestError(
      "Could not find the table 'public.bot_runs' in the schema cache",
      { status: 404, payload: { code: 'PGRST205' } },
    );
    const postgresMiss = new SupabaseRequestError(
      'relation "public.bot_memories" does not exist',
      { status: 400, payload: { code: '42P01' } },
    );

    expect(isMissingProductionBotsSchemaError(schemaCacheMiss)).toBe(true);
    expect(isMissingProductionBotsSchemaError(postgresMiss)).toBe(true);
  });

  it('recognizes missing Bot RPCs and columns so partial schemas fail closed', () => {
    const missingFunction = new SupabaseRequestError(
      'Could not find the function public.devryan_claim_bot_run in the schema cache',
      { status: 404, payload: { code: 'PGRST202' } },
    );
    const missingColumn = new SupabaseRequestError(
      "Could not find the 'computer_scope' column of 'bot_runs' in the schema cache",
      { status: 400, payload: { code: 'PGRST204' } },
    );

    expect(isMissingProductionBotsSchemaError(missingFunction)).toBe(true);
    expect(isMissingProductionBotsSchemaError(missingColumn)).toBe(true);
    expect(isMissingProductionBotsSchemaError(new SupabaseRequestError(
      'Could not find the function public.devryan_enqueue_bot_message_run in the schema cache',
      { status: 404, payload: { code: 'PGRST202' } },
    ))).toBe(true);
  });

  it('maps a stale schema to the stable HTTP 503 migration envelope', () => {
    const error = new SupabaseRequestError(
      "Could not find the table 'public.bots' in the schema cache",
      { status: 404, payload: { code: 'PGRST205' } },
    );

    expect(productionBotsMigrationFailurePayload(error)).toEqual({
      status: 503,
      error: 'Database migration required',
      code: 'bot_schema_migration_required',
      requiredMigration: '20260902120000',
    });
  });

  it('does not relabel authorization, unrelated schema, or transport failures', () => {
    const permissionDenied = new SupabaseRequestError(
      'permission denied for table bot_runs',
      { status: 403, payload: { code: '42501' } },
    );
    const unrelatedMissingTable = new SupabaseRequestError(
      "Could not find the table 'public.invoices' in the schema cache",
      { status: 404, payload: { code: 'PGRST205' } },
    );

    expect(isMissingProductionBotsSchemaError(permissionDenied)).toBe(false);
    expect(isMissingProductionBotsSchemaError(unrelatedMissingTable)).toBe(false);
    expect(isMissingProductionBotsSchemaError(new TypeError('fetch failed'))).toBe(false);
    expect(productionBotsMigrationFailurePayload(permissionDenied)).toBeNull();
  });
});
