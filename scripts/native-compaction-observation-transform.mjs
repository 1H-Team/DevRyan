import {createHash} from 'node:crypto';
import path from 'node:path';
export const NATIVE_COMPACTION_SOURCE_SHA256='c609a7b75ac8f4b1783d79fe8fb9e69430302d425bb410af866ec951ec299fee';
const hash=value=>createHash('sha256').update(value).digest('hex');
const anchor='    const budget = trigger.reason === "overflow" ? Math.min(model.cap, Math.floor(total(trigger.estimate ?? estimatePrompt2(context)) * SHRINK_STEPS[0])) : model.cap;\n';
// 2.2.0 keeps the selected model's ceiling inside selectModel; the evidence
// recomputes it with the same pure calculateCeiling from that selected model.
// It records the prompt estimate native used: the trigger's own when supplied.
const ceiling='calculateCeiling(model.context.model.limit, settings.buffer)';
const estimate='(trigger.estimate ?? estimatePrompt2(context))';
const inserted=`    try { observeNativeCompactionBudget(trigger, {
      auto: settings.auto, buffer: settings.buffer ?? null, keep: settings.keep,
      ceiling: Number.isFinite(${ceiling}) ? ${ceiling} : null, budget,
      estimatePrompt: ${estimate}, estimateContext: total(${estimate}),
      limits: { context: context.model.limit.context, input: context.model.limit.input ?? null, output: context.model.limit.output },
      anchorIndex: context.messages.findLastIndex(message => hasMeasuredPrompt(message, context.model.ref)),
      checkpointIndex: context.messages.findLastIndex(isNativeCompaction2), stateRevision: state.revision(), due: due(context, ${ceiling}, trigger.estimate)
    }); } catch { /* Read-only evidence must not alter native compaction. */ }
`;
export function rewriteNativeCompactionObservation(source,helperSpecifier){
 if(typeof helperSpecifier!=='string'||!path.isAbsolute(helperSpecifier)||/[\0\r\n]/.test(helperSpecifier)
   ||hash(source)!==NATIVE_COMPACTION_SOURCE_SHA256||source.split(anchor).length!==2)throw new Error('native_compaction_observation_source_changed');
 const prefix=`import { observeNativeCompactionBudget } from ${JSON.stringify(helperSpecifier)};\n`;
 const contents=prefix+source.replace(anchor,anchor+inserted);
 return {contents,originalSha256:hash(source),transformedSha256:hash(contents)};
}
