import {expect,test} from 'bun:test';
import {generateCursorHelperText} from './text-generation.js';

test('Cursor helper preserves raw multiline output and exact model, without tools, settings or agent history',async()=>{
 const calls=[];const text='  # commit title\n\nbody with punctuation.\n';
 const result=await generateCursorHelperText({Agent:{prompt:async(...args)=>{calls.push(args);return {result:text};}},apiKey:'fixture',text:'Exact supplied prompt',directory:'/fixture',model:{id:'selected',thinking:true}});
 expect(result).toBe(text);expect(calls).toEqual([['Exact supplied prompt',{apiKey:'fixture',model:{id:'selected',thinking:true},tools:[],local:{cwd:'/fixture',settingSources:[]},platform:{workspaceRef:'/fixture'}}]]);
});
test('Cursor helper refuses oversized output and propagates provider rejection without retry',async()=>{
 let calls=0;const input={apiKey:'fixture',text:'prompt',model:{id:'selected'}};
 await expect(generateCursorHelperText({...input,maxOutputBytes:4,Agent:{prompt:async()=>{calls++;return {result:'12345'};}}})).rejects.toMatchObject({code:'cursor_helper_output_invalid'});
 await expect(generateCursorHelperText({...input,Agent:{prompt:async()=>{calls++;throw Error('provider failure');}}})).rejects.toThrow('provider failure');expect(calls).toBe(2);
});
