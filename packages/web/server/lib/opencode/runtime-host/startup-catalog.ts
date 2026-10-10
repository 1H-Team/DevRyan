import { Schema, type Context } from 'effect';
import { inspectModelSelection } from '@openchamber/shared-runtime';
import { Plugin } from '@opencode/schema/plugin';
import type { NativeCatalogRequirements, NativeCursorCatalog, NativeCatalogAvailability } from './native-process-protocol.js';
import { runWithHostRefusal } from './host-refusal.js';
import { createNativeCatalogDiagnostics, nativeCatalogCause } from './native-catalog-diagnostics.js';
const catalogRoutes = { '/api/agent':'agent', '/api/plugin':'plugin', '/api/model':'model' } as const;
const IDs = Schema.Array(Schema.Struct({ id: Schema.String }));
const Models = Schema.Array(Schema.Struct({ id: Schema.String, providerID: Schema.String,
  variants:Schema.optional(Schema.Array(Schema.Struct({id:Schema.String}))) }));
export interface NativeCatalogAssertion { readonly asserted:boolean;readonly missing:NativeCatalogRequirements;readonly availability:NativeCatalogAvailability }
/** Query the controller's actual location graphs, never reconstruct a second SDK. */
export async function assertNativeCatalog(options: { readonly directories:readonly string[];
  readonly requirements:NativeCatalogRequirements;readonly handler:(request:Request, context?:Context.Context<never>)=>Promise<Response>;
  readonly cursorCatalog?:NativeCursorCatalog;
  readonly requirementsForDirectory?:(directory:string)=>NativeCatalogRequirements|undefined;
  readonly tools:(directory:string)=>Promise<readonly string[]> }):Promise<NativeCatalogAssertion> {
  const selections: NativeCatalogAvailability['selections'][number][] = [];
  const missing = { agents:new Set<string>(),plugins:new Set<string>(),tools:new Set<string>(),models:new Map<string,{providerID:string;id:string;variant?:string}>() };
  for (const directory of options.directories) {
    const requirements = options.requirementsForDirectory ? options.requirementsForDirectory(directory) : options.requirements;
    if (!requirements) throw new Error('native_catalog_requirements_missing');
    const read = async (route:keyof typeof catalogRoutes):Promise<unknown> => {
      let response:Response|undefined;
      const diagnostics = createNativeCatalogDiagnostics();
      const result = await diagnostics.run(() => runWithHostRefusal(async () => response = await options.handler(new Request(`http://native${route}`, { headers:{'x-opencode-directory':encodeURIComponent(directory)} }), diagnostics.context)));
      if (!result.ok || !result.value.ok) {
        const cause=!result.ok?nativeCatalogCause(result.refusal):diagnostics.cause();
        const status=response?`http_${response.status}`:`refusal_${!result.ok?result.refusal.status:503}`;
        for (const schemaPath of diagnostics.paths()) console.error(`level=error msg=response_schema_invalid name=HttpApiSchemaError schemaPath=${schemaPath}`);
        throw new Error(`native_catalog_read_failed_${catalogRoutes[route]}_${status}_${cause??'cause_unavailable'}`);
      }
      response=result.value;
      const body:unknown = await response.json();
      if (!body || typeof body !== 'object' || !('location' in body) || !body.location || typeof body.location !== 'object'
        || !('directory' in body.location) || body.location.directory !== directory || !('data' in body)) throw new Error('native_catalog_location_invalid');
      return body.data;
    };
    await read('/api/agent');
    // Agent loading initializes this actual location graph; wait for its
    // registrations before taking the final plugin/model/tool inventory.
    const tools = await options.tools(directory);
    const agents = Schema.decodeUnknownSync(IDs)(await read('/api/agent'));
    const plugins = Schema.decodeUnknownSync(Schema.Array(Plugin.Info))(await read('/api/plugin'));
    const models = Schema.decodeUnknownSync(Models)(await read('/api/model'));
    for (const id of requirements.agents) if (!agents.some(row=>row.id===id)) missing.agents.add(id);
    for (const id of requirements.plugins) if (!plugins.some(row=>row.id===id && row.state.status==='active')) missing.plugins.add(id);
    for (const id of requirements.tools) if (!tools.includes(id)) missing.tools.add(id);
    const providers = [...new Set(models.map(model => model.providerID))].map(id => ({
      id, models: models.filter(model => model.providerID === id),
    }));
    const required = requirements.selections ?? requirements.models.map((ref, index) => ({
      source: { kind: 'requirement' as const, index }, providerID: ref.providerID, modelID: ref.id,
      variant: ref.variant === 'default' ? null : ref.variant ?? null,
    }));
    for (const selection of required) {
      // Offline Cursor declarations cannot establish selected-account access or
      // completeness. Dispatch queries that account's SDK and validates exactly.
      const inspection = selection.providerID === 'cursor-acp'
        ? { status: 'unknown' as const, reason: 'catalog_unavailable' as const }
        : inspectModelSelection(selection, { providers });
      selections.push({ directory, ...selection, ...inspection });
      if (inspection.status === 'unavailable') {
        const ref = { providerID: selection.providerID, id: selection.modelID, variant: selection.variant ?? 'default' };
        missing.models.set(JSON.stringify(ref), ref);
      }
    }
  }
  const result = { agents:[...missing.agents],plugins:[...missing.plugins],tools:[...missing.tools],models:[...missing.models.values()] };
  return { asserted:result.agents.length === 0 && result.plugins.length === 0 && result.tools.length === 0,
    missing:result, availability:{ selections } };
}
