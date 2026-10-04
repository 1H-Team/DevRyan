import type { NativeCatalogSelection } from './native-process-protocol.js';
import type { RuntimeBundleDescriptor } from './runtime-bundle.js';
import type { ReviewedSkill } from './reviewed-skills.js';
import type {ReviewedSlimAgentData} from '../../../../runtime/reviewed-inputs/slim-2.2.25/dist/server/index.js';
import type {NativeTextReference} from './native-text-settings.js';
export interface NativeConfigurationLocation {
  readonly directory: string; readonly configuration: Record<string, unknown>; readonly skills: readonly ReviewedSkill[];
  readonly instructions:readonly NativeTextReference[]; readonly textReferences:readonly NativeTextReference[];
  readonly aliases: readonly { readonly name: string; readonly targetID: string }[]; readonly activePlugins: readonly string[];readonly activeRegistrationIDs?:readonly string[];
  readonly compatibility: { readonly legacy: Record<string, unknown>; readonly agents: Record<string, unknown>; readonly commands: Record<string, unknown>; readonly slim: unknown; readonly ponytail?:{readonly defaultMode:'off'|'lite'|'full'|'ultra';readonly source:'environment'|'configuration'|'default'}; readonly mcp: Record<string, unknown> };
  readonly requiredCatalogs: { readonly selections?: readonly NativeCatalogSelection[]; readonly agents: readonly string[]; readonly plugins: readonly string[]; readonly tools: readonly string[]; readonly models: readonly { readonly providerID: string; readonly id: string;readonly variant?:string }[]; readonly skills: readonly string[]; readonly commands: readonly string[]; readonly mcp: readonly string[] };
}
export interface NativeConfigurationSnapshot { readonly schema: 1; readonly revision: number; readonly sourceStamp: string; readonly digest: string; readonly registrationManifestDigest: string; readonly locations: readonly NativeConfigurationLocation[] }
export interface ResolveNativeConfigurationSnapshot { readonly binding: { readonly descriptor: RuntimeBundleDescriptor }; readonly revision: number; readonly expectedRegistrationDigest: string }
export interface LoadedNativeSettings { readonly legacy: Record<string, unknown>; readonly agents: Record<string, unknown>; readonly commands: Record<string, unknown>; readonly skills: { name: string; path: string; source?: string; scope?: string }[]; readonly slim: unknown; readonly parseMarkdown: (path: string) => { body: string; frontmatter: Record<string, unknown> } }
export function createNativeConfigurationSnapshotResolver(options?: {readonly getRuntimeLocations?:()=>Promise<readonly {readonly directory:string}[]>; readonly ponytailCommands?:Readonly<Record<string,{readonly description:string;readonly template:string}>>; readonly ponytailDefaultMode?:string; readonly resolveSlimAgents?:(input:ReviewedSlimAgentData)=>Promise<{readonly agents:Record<string,unknown>;readonly defaultAgent?:string;readonly backgroundJobs?:Readonly<Record<string,unknown>>}>|{readonly agents:Record<string,unknown>;readonly defaultAgent?:string;readonly backgroundJobs?:Readonly<Record<string,unknown>>}; readonly loadLocation?: (input: { directory: string; launch: RuntimeBundleDescriptor['launch'] }) => Promise<LoadedNativeSettings> }): (input: ResolveNativeConfigurationSnapshot) => Promise<NativeConfigurationSnapshot>;
export const resolveNativeConfigurationSnapshot: (input: ResolveNativeConfigurationSnapshot) => Promise<NativeConfigurationSnapshot>;
export function nativeCatalogModels(configuration:Record<string,unknown>,compatibility:NativeConfigurationLocation['compatibility'],explicit?:NativeConfigurationLocation['requiredCatalogs']['models']):NativeConfigurationLocation['requiredCatalogs']['models'];

export function nativeCatalogSelections(configuration:Record<string,unknown>,compatibility:NativeConfigurationLocation['compatibility'],explicit?:NativeConfigurationLocation['requiredCatalogs']['models']):readonly NativeCatalogSelection[];
