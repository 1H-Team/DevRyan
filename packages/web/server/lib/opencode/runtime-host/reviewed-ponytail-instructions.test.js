import {expect,it} from 'vitest';
import {renderReviewedPonytailInstructions} from './reviewed-ponytail-instructions.js';
it('renders exact shared-builder modes deterministically without ambient default settings',async()=>{
 const first=await renderReviewedPonytailInstructions(),again=await renderReviewedPonytailInstructions();
 expect(first).toEqual(again);expect(Object.keys(first.instructions)).toEqual(['lite','full','ultra','review']);
 expect(first.instructions.lite).toContain('PONYTAIL MODE ACTIVE — level: lite\n\n');
 expect(first.instructions.review).toBe('PONYTAIL MODE ACTIVE — level: review. Behavior defined by /ponytail-review skill.');
 expect(first.instructions.full).not.toBe(first.instructions.lite);expect(first.moduleSource).toContain('export default');expect(first.moduleSource).toContain('export const command=commands.ponytail;');expect(Object.keys(first.commands)).toHaveLength(6);expect(first.command.template.startsWith('Switch')).toBe(true);expect(first.command.template.endsWith('\n')).toBe(false);expect(first.command.template).toContain('Switch to ponytail $ARGUMENTS mode.');expect(first.sourceSHA256.command).toBe('800919b5c7b53f05e9adb96e5978818f3b5cd9137bc2df35b1575590d5464f14');
});
