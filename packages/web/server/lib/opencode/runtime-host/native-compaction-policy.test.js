import { expect, it } from 'vitest';
import { nativeCompactionReserve } from './native-compaction-policy.js';
import { normalizeOpenAIModels } from '../../../default-config/plugins/openai-gpt-5-6-models.mjs';
it('native compaction buffer owns the provider budget including zero, with legacy-only fallback',()=>{
  const location={configuration:{compaction:{buffer:12000}},compatibility:{legacy:{compaction:{reserved:9000}}}};
  expect(nativeCompactionReserve(location)).toBe(12000);
  location.configuration.compaction.buffer=0; expect(nativeCompactionReserve(location)).toBe(0);
  delete location.configuration.compaction.buffer; expect(nativeCompactionReserve(location)).toBe(9000);
  expect(nativeCompactionReserve()).toBeUndefined();
  for(const buffer of ['1000',Infinity,NaN,null,-1,1.5]) {
    location.configuration.compaction.buffer=buffer;
    expect(nativeCompactionReserve(location)).toBeUndefined();
  }
  expect(location.compatibility.legacy.compaction.reserved).toBe(9000);
});
it('the actual provider policy uses native buffer for the compaction input threshold, preserving usable context',()=>{
  const location={configuration:{compaction:{buffer:12000}},compatibility:{legacy:{compaction:{reserved:9000}}}};
  const models={'gpt-5.6-sol':{id:'gpt-5.6-sol',limit:{context:1,output:32000},options:{},variants:{}}};
  for(const buffer of [12000,0]) {
    location.configuration.compaction.buffer=buffer;
    const result=normalizeOpenAIModels(models,{oauth:true,compactionReserved:nativeCompactionReserve(location)});
    expect(result['gpt-5.6-sol'].limit).toMatchObject({input:256000+buffer,context:1050000});
    expect(models['gpt-5.6-sol'].limit.context).toBe(1);
  }
});
