import {createHash} from 'node:crypto';
import path from 'node:path';
export const NATIVE_COMPACTION_SOURCE_SHA256='bcc04896d58a63961e60c3441781d179a0cfc25f714c038f57f3f57e20644839';
export const NATIVE_COMPACTION_SOURCE_SUFFIX='@opencode/core/dist/chunks/shell-s389npg2.js';
const hash=value=>createHash('sha256').update(value).digest('hex');
const anchor='    const budget = trigger.reason === "overflow" ? Math.min(cap, Math.floor(estimateContext2(context) * SHRINK_STEPS[0])) : cap;\n';
const inserted=`    try { observeNativeCompactionBudget(trigger, {
      auto: settings.auto, buffer: settings.buffer ?? null, keep: settings.keep,
      ceiling: Number.isFinite(ceiling) ? ceiling : null, budget,
      estimatePrompt: estimatePrompt2(context), estimateContext: estimateContext2(context),
      limits: { context: context.model.limit.context, input: context.model.limit.input ?? null, output: context.model.limit.output },
      anchorIndex: context.messages.findLastIndex(message => hasMeasuredPrompt(message, context.model.ref)),
      checkpointIndex: context.messages.findLastIndex(isNativeCompaction2), stateRevision: state.revision(), due: due(context, ceiling)
    }); } catch { /* Read-only evidence must not alter native compaction. */ }
`;
export function rewriteNativeCompactionObservation(source,helperSpecifier){
 if(typeof helperSpecifier!=='string'||!path.isAbsolute(helperSpecifier)||/[\0\r\n]/.test(helperSpecifier)
   ||hash(source)!==NATIVE_COMPACTION_SOURCE_SHA256||source.split(anchor).length!==2)throw new Error('native_compaction_observation_source_changed');
 const prefix=`import { observeNativeCompactionBudget } from ${JSON.stringify(helperSpecifier)};\n`;
 const contents=prefix+source.replace(anchor,anchor+inserted);
 return {contents,originalSha256:hash(source),transformedSha256:hash(contents)};
}
