/** Hash-guarded native exports; raw process helper is confined-worker only. */
import type {NativeBrowserOriginals,NativeBrowserLaunch,NativeBrowserInput,NativeBrowserSpawn} from '../../lib/opencode/runtime-host/native-browser.ts';
import type {Tool} from '@opencode/schema/tool';
export const reviewedBrowserDescription:string;
export const reviewedBrowserInputSchema:Tool.ValueSchema<NativeBrowserInput>;
export const DevRyanBrowserPlugin:NativeBrowserOriginals['DevRyanBrowserPlugin'];
export const withReviewedBrowserOwner:NativeBrowserOriginals['withReviewedBrowserOwner'];
export function runReviewedBrowserBinary(input:NativeBrowserLaunch&{readonly spawnImpl:NativeBrowserSpawn}):Promise<string>;
