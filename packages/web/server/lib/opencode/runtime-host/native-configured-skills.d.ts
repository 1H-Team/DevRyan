import type {RuntimeBundleDescriptor} from './runtime-bundle.js';
import type {LoadedNativeSettings} from './native-configuration-snapshot.js';
export function configuredNativeSkillDirectories(input:{readonly settings:unknown;readonly directory:string;readonly launch:RuntimeBundleDescriptor['launch']}):Promise<string[]>;
export function discoverConfiguredNativeSkills(input:{readonly directories:readonly string[];readonly directory:string;readonly parseMarkdown:LoadedNativeSettings['parseMarkdown']}):Promise<LoadedNativeSettings['skills']>;
