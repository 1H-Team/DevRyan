import {expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import {scopedApprovedPlanContent,validateApprovedPlanRef,verifyApprovedPlanRef} from './approved-plan.js';
const plan='# Feature\n## Constraints & assumptions\nKeep private.\n## Implementation\n### Phase 1: Backend\nWrite backend.\n### Phase 2: Client\nWrite client.\n## Verification\nRun checks.';
it('selects an exact phase with shared constraints and verification, excluding sibling work',()=>{
 const content=scopedApprovedPlanContent(plan,'Phase 1: Backend');
 expect(content).toContain('Keep private.');expect(content).toContain('Write backend.');expect(content).toContain('Run checks.');expect(content).not.toContain('Write client.');
 expect(()=>scopedApprovedPlanContent(plan,'Phase 1')).toThrow();
 expect(()=>scopedApprovedPlanContent(plan+'\n### Phase 1: Backend\nAmbiguous','Phase 1: Backend')).toThrow();
 expect(scopedApprovedPlanContent('```md\n### Phase 1: Backend\nIgnore\n```\n'+plan,'Phase 1: Backend')).not.toContain('Ignore');
});
it('binds immutable content and rejects oversized or escaping scope',async()=>{
 const content=scopedApprovedPlanContent(plan,'Phase 1: Backend');
 const ref={rootSessionId:'ses_root',objectiveId:'msg_goal',sourceMessageId:'msg_plan',version:'a'.repeat(64),phase:'Phase 1: Backend',paths:['src'],content,contentHash:createHash('sha256').update(content).digest('hex')};
 expect(()=>validateApprovedPlanRef(ref)).not.toThrow();
 await expect(verifyApprovedPlanRef({...ref,content:content+'changed'})).rejects.toThrow();
 expect(()=>validateApprovedPlanRef({...ref,paths:['../other']})).toThrow();
 expect(()=>scopedApprovedPlanContent('# Plan\n## Phase\n'+'x'.repeat(33*1024),'Phase')).toThrow();
});
