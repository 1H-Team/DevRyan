import {createHash} from 'node:crypto';
import path from 'node:path';
export const NATIVE_FINALIZATION_SOURCE_SHA256='49a5b3de32ec01d86bc4ae0023ef9838f0fedf78c78ea6fe41a9d747a821684e';
export const NATIVE_FINALIZATION_SOURCE_SUFFIX='@opencode/core/dist/chunks/instance-dy6575tn.js';
const hash=value=>createHash('sha256').update(value).digest('hex');
const start='      if (record.finish || record.failure) {\n';
const end='      if (llmFailure && llmError && retry?.retry && record.outputStarted';
const commit='            files\n          });\n';
/** Observation only: the pinned runner still owns every native decision/write. */
export function rewriteNativeFinalizationObservation(source,helperSpecifier){
  if(typeof helperSpecifier!=='string'||!path.isAbsolute(helperSpecifier)||/[\0\r\n]/.test(helperSpecifier)
    ||hash(source)!==NATIVE_FINALIZATION_SOURCE_SHA256||source.split(start).length!==2||source.split(end).length!==2)throw new Error('native_finalization_observation_source_changed');
  const from=source.indexOf(start),to=source.indexOf(end,from),original=source.slice(from,to);
  if(original.split(commit).length!==2)throw new Error('native_finalization_observation_source_changed');
  const identity='{ sessionID: input.sessionID, assistantMessageID: input.assistantMessageID }';
  const snapshot='        const snapshot = yield* snapshots.capture();\n';
  if(original.split(snapshot).length!==2)throw new Error('native_finalization_observation_source_changed');
  const block=original.replace(snapshot,snapshot+`        if (snapshot !== undefined) yield* nativeFinalizationProgress(input.prepared.request, ${identity});\n`).replace(commit,commit+`        if (record.finish && usage && !record.failure) yield* nativeFinalizationProgress(input.prepared.request, ${identity});\n`);
  const wrapped=`      yield* observeNativeFinalization(input.prepared.request, ${identity}, Boolean(record.finish && !record.failure && !interrupted && !llmError && !recorded.providerFailed), Effect.gen(function* () {\n${block}      }));\n`;
  const contents=`import { observeNativeFinalization, nativeFinalizationProgress } from ${JSON.stringify(helperSpecifier)};\n`+source.slice(0,from)+wrapped+source.slice(to);
  return {contents,originalSha256:hash(source),transformedSha256:hash(contents)};
}
