import {createHash} from 'node:crypto';
import path from 'node:path';
export const NATIVE_COMPACTION_SOURCE_SHA256='f87bbbf98cab1502f07162ab01d411eb26daa8a5c3a355fa3b25ea30d272f21a';
export const NATIVE_COMPACTION_SOURCE_SUFFIX='@opencode/core/dist/chunks/location-services-qhaz1dgr.js';
const hash=value=>createHash('sha256').update(value).digest('hex');
const anchor='    const budget = trigger.reason === "overflow" ? Math.min(cap, Math.floor(estimateContext2(context) * SHRINK_STEPS[0])) : cap;\n';
const inserted=`    try { observeNativeCompactionBudget(trigger, {
      auto: settings.auto, buffer: settings.buffer ?? null, keep: settings.keep,
      ceiling: Number.isFinite(ceiling) ? ceiling : null, budget,
      estimatePrompt: estimatePrompt2(context), estimateContext: estimateContext2(context),
      limits: { context: context.model.limit.context, input: context.model.limit.input ?? null, output: context.model.limit.output },
      anchorIndex: context.messages.findLastIndex(message => hasMeasuredPrompt(message, context.model.ref)),
      checkpointIndex: context.messages.findLastIndex(isCheckpoint2), stateRevision: state.revision(), due: due(context, ceiling)
    }); } catch { /* Read-only evidence must not alter native compaction. */ }
`;
export function rewriteNativeCompactionObservation(source,helperSpecifier){
 if(typeof helperSpecifier!=='string'||!path.isAbsolute(helperSpecifier)||/[\0\r\n]/.test(helperSpecifier)
   ||hash(source)!==NATIVE_COMPACTION_SOURCE_SHA256||source.split(anchor).length!==2)throw new Error('native_compaction_observation_source_changed');
 const prefix=`import { observeNativeCompactionBudget } from ${JSON.stringify(helperSpecifier)};\n`;
 const contents=prefix+source.replace(anchor,anchor+inserted);
 return {contents,originalSha256:hash(source),transformedSha256:hash(contents)};
}
