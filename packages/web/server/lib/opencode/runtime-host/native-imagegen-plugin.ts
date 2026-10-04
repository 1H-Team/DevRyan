import {Effect} from 'effect';
import {Plugin} from '@opencode/plugin/effect';
import {Tool} from '@opencode/schema/tool';
import {tool as reviewedTool} from '@opencode-ai/plugin/tool';
import {reviewedImagegenDescription,reviewedImagegenInputSchema} from '../../../../runtime/reviewed-inputs/imagegen-0.1.12/dist/index.js';

export const NATIVE_IMAGEGEN_PLUGIN_ID='opencode-gpt-imagegen';
/** The original schema is registered; its complete executor runs in an owned writer. */
export const nativeImagegenPlugin=Plugin.define({id:NATIVE_IMAGEGEN_PLUGIN_ID,effect:({tool})=>tool.transform(editor=>{
 editor.add({name:'gpt_imagegen',description:reviewedImagegenDescription,input:reviewedImagegenInputSchema,output:reviewedTool.schema.string(),
  options:{codemode:false},execute:()=>Effect.fail(new Tool.Error({message:'native_imagegen_worker_required'}))});
})});
