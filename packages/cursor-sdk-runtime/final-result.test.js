import { expect, test } from 'bun:test';
import { cursorFinalText, cursorFinalTextTarget } from './final-result.js';
import { PinnedAccumulator } from './fixtures/pinned-accumulator.js';

test('pinned accumulator independently qualifies running tools, empty reasoning and completion-only boundaries', async () => {
  const text = text => ({ type: 'text-delta', text });
  for (const [updates, expected] of [
    [[text('A'), {type:'tool-call-started',callId:'tool',toolCall:{type:'read'}}, text('B'),
      {type:'tool-call-completed',callId:'tool',toolCall:{type:'read'}}, text('C')], [['assistantMessage','AB'],['toolCall',undefined],['assistantMessage','C']]],
    [[text('A'), {type:'thinking-delta',text:''}, text('B')], [['assistantMessage','A'],['thinkingMessage',''],['assistantMessage','B']]],
    [[text('A'), {type:'thinking-completed',thinkingDurationMs:12}, text('B')], [['assistantMessage','AB']]],
  ]) {
    const accumulator = new PinnedAccumulator();
    for (const update of updates) await accumulator.apply(update);
    expect(accumulator.conversation()[0].turn.steps.map(step => [step.type, step.message.text])).toEqual(expected);
    expect(accumulator.finalAssistantText()).toBe(expected.at(-1)[1]);
  }
});

for (const scenario of ['absent', 'empty', 'final-only', 'text-tool', 'text-tool-empty', 'text-tool-nonempty', 'reasoning']) {
  test(`SDK 1.0.28 source result association: ${scenario}`, async () => {
    const accumulator = new PinnedAccumulator();
    if (scenario !== 'absent' && scenario !== 'empty' && scenario !== 'final-only') await accumulator.apply({ type: 'text-delta', text: 'earlier' });
    if (scenario.startsWith('text-tool')) await accumulator.apply({ type: 'tool-call-completed', toolCall: {type:'read'} });
    if (scenario === 'reasoning') await accumulator.apply({type:'thinking-delta',text:'thought'});
    if (scenario === 'empty' || scenario === 'text-tool-empty') await accumulator.apply({type:'text-delta',text:''});
    if (scenario === 'final-only' || scenario === 'text-tool-nonempty' || scenario === 'reasoning') await accumulator.apply({type:'text-delta',text:'final'});
    const result = accumulator.finalAssistantText();
    expect(result).toBe(scenario === 'absent' ? undefined : scenario === 'empty' || scenario === 'text-tool-empty' ? '' : scenario === 'text-tool' ? 'earlier' : 'final');
    const final = await cursorFinalText({result}, {conversation: async () => accumulator.conversation()});
    if (scenario === 'absent') expect(final).toEqual({});
    else {
      const before = ['text-tool-empty','text-tool-nonempty','reasoning'].includes(scenario) ? 1 : 0;
      expect(final.finalTextWitness).toEqual({assistantOrdinal:before+1,priorNonempty:before});
      expect(cursorFinalTextTarget(final.finalTextWitness, before)).toBe(before);
      expect(cursorFinalTextTarget(final.finalTextWitness, before+1)).toBe(before);
      expect(Object.keys(final)).toEqual(['finalText','finalTextWitness']);
    }
  });
}

test('missing, inconsistent, failed and oversized private witnesses refuse without exposing content', async () => {
  const step = text => ({type:'agentConversationTurn',turn:{steps:[{type:'assistantMessage',message:{text}}]}});
  for (const run of [{}, {conversation: async()=>[]}, {conversation:async()=>[step('other')]},
    {conversation:async()=>{throw Error('private detail');}}, {conversation:async()=>Array(4097).fill(step('x'))},
    {conversation:async()=>[step('x'.repeat(16*1024*1024+1))]}]) {
    await expect(cursorFinalText({result:'private response'},run)).rejects.toMatchObject({code:'CURSOR_STREAM_FINAL_ASSOCIATION_INVALID'});
  }
  for (const witness of [null,{assistantOrdinal:1,priorNonempty:0,raw:'private'}, {assistantOrdinal:1,priorNonempty:1}]) {
    expect(()=>cursorFinalTextTarget(witness,1)).toThrow('Cursor final association unavailable');
  }
  expect(()=>cursorFinalTextTarget({assistantOrdinal:2,priorNonempty:1},3)).toThrow('Cursor final association unavailable');
});

test('resolved SDK failure remains a provider failure before final-text reconciliation', async () => {
  await expect(cursorFinalText({status:'error',error:{message:'quota refused',code:'RESOURCE_EXHAUSTED'}},{}))
    .rejects.toMatchObject({name:'CursorAgentError',code:'RESOURCE_EXHAUSTED',cursorFailureSource:'provider'});
});
