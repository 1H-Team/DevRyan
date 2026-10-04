import {test,expect} from 'bun:test';
import {createHash} from 'node:crypto';
import {applyNativeImageContext,createControllerImages} from '../../packages/web/server/lib/opencode/runtime-host/controller-images.js';
test('native media replacement matches exact canonical bytes and preserves unrelated context references',async()=>{
 const data=Buffer.from('canonical image'),digest=createHash('sha256').update(data).digest('hex');
 const text={type:'text',text:'rewritten mention'},other={type:'media',media:{source:{type:'bytes',data:Buffer.from('other'),mediaType:'image/png'}},filename:'same.png'};
 const message={info:{id:'msg_user',role:'user'},parts:[text,other,{type:'media',media:{source:{type:'base64',data:data.toString('base64'),mediaType:'image/png'}},filename:'same.png'}]};
 const result={imagesSkipped:false,replacements:[{messageID:'msg_user',text:'Original image notice',images:[{sha256:digest,mime:'image/png',name:'same.png'}]}]};
 applyNativeImageContext([message],result);expect(message.parts).toEqual([text,other,{type:'text',text:'Original image notice'}]);expect(message.parts[0]).toBe(text);expect(message.parts[1]).toBe(other);
 expect(()=>applyNativeImageContext([message],result)).toThrow('native_image_context_identity_changed');
 const calls:string[]=[];const transform=createControllerImages(async(method)=>{calls.push(method);throw Error('request failed');},async()=>{throw Error('unexpected notice');});
 await expect(transform({permit:{token:'p',revision:0,sessionID:'ses_images'},directory:'/owned',sessionID:'ses_images',domain:'session',phase:'context',event:{},signal:new AbortController().signal},{},{messages:[message]})).rejects.toThrow('request failed');
 expect(calls).toEqual(['native.slim.images','native.slim.images.settle']);
});
