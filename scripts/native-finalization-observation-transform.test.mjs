import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {rewriteNativeFinalizationObservation,NATIVE_FINALIZATION_SOURCE_SHA256} from './native-finalization-observation-transform.mjs';
const sourceFile=path.resolve('node_modules/@opencode/core/dist/chunks/shell-4nejsby7.js');
const helper=path.resolve('packages/web/server/lib/opencode/runtime-host/native-finalization-observation.ts');
test('pinned finalization seam wraps original post-model mandatory IO only after tool joins without changing its decisions',async()=>{
 const source=await fs.readFile(sourceFile,'utf8');assert.equal(createHash('sha256').update(source).digest('hex'),NATIVE_FINALIZATION_SOURCE_SHA256);
 const result=rewriteNativeFinalizationObservation(source,helper),marker='      yield* observeNativeFinalization(';
 assert.equal(result.contents.split(marker).length,2);
 assert.ok(result.contents.indexOf(marker)>result.contents.indexOf('Fiber.awaitAll(toolRuns.map'));
 assert.ok(result.contents.indexOf(marker)>result.contents.indexOf('const record = publisher.record();'));
 assert.match(result.contents,/Boolean\(record.finish && !record.failure && !interrupted && !llmError && !recorded.providerFailed\)/);
 const body=result.contents.slice(result.contents.indexOf(marker),result.contents.indexOf('      if (llmFailure && llmError && retry?.retry && record.outputStarted'));
 assert.match(body,/const snapshot = yield\* snapshots.capture\(\);/);assert.match(body,/yield\* bus.publish\(SessionEvent2.Step.Ended/);
 assert.ok(body.indexOf('nativeFinalizationProgress')>body.indexOf('snapshots.capture()'));
 assert.equal(result.contents.match(/yield\* bus.publish\(SessionEvent2.Step.Ended/g).length,1);
 assert.equal(result.contents.match(/if \(record.failure\)/g).length,source.match(/if \(record.failure\)/g).length);
});
test('source drift and an invalid helper path refuse instead of selecting a guessed seam',async()=>{
 const source=await fs.readFile(sourceFile,'utf8');
 for(const changed of [source+'\n',source.replace('Fiber.awaitAll','Fiber.joinAll'),source.replace('publisher.record()','publisher.snapshot()')])assert.throws(()=>rewriteNativeFinalizationObservation(changed,helper),/native_finalization_observation_source_changed/);
 for(const invalid of ['relative',helper+'\0',helper+'\r',helper+'\n'])assert.throws(()=>rewriteNativeFinalizationObservation(source,invalid),/native_finalization_observation_source_changed/);
});
