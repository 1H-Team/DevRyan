import {expect,it} from 'vitest';
import * as runtime from './opencode-update-runtime.js';
it('retains only pure version identity for offline evidence',()=>{
 expect(Object.keys(runtime)).toEqual(['openCodeBaseVersion']);
 expect(runtime.openCodeBaseVersion('2.0.20')).toBe('2.0.20');
 expect(runtime.openCodeBaseVersion('1.18.33-devryan.1')).toBe('1.18.33');
 expect(runtime.openCodeBaseVersion(null)).toBe(null);
});
