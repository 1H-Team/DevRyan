import {afterEach,expect,test as it} from 'bun:test';
import {createHelperModelRevision,parseHelperModelSelection} from './helperModelSelection';
const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
const setCrypto = (value: unknown) => Object.defineProperty(globalThis, 'crypto', {configurable:true,value});
afterEach(()=>{
  if(cryptoDescriptor)Object.defineProperty(globalThis,'crypto',cryptoDescriptor);
  else Reflect.deleteProperty(globalThis,'crypto');
});
it('creates a valid helper revision without secure-context randomUUID',()=>{
  setCrypto(undefined);
  const revision=createHelperModelRevision();
  expect(parseHelperModelSelection({providerID:'fixture',modelID:'selected',revision})).toEqual({providerID:'fixture',modelID:'selected',revision});
});
it('uses the available UUID facility and preserves its failure for the save finally owner',()=>{
  setCrypto({randomUUID:()=> 'selected-revision'});expect(createHelperModelRevision()).toBe('selected-revision');
  setCrypto({randomUUID:()=>{throw Error('UUID unavailable');}});expect(()=>createHelperModelRevision()).toThrow('UUID unavailable');
});
