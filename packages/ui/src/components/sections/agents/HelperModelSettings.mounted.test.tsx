import React, { act } from 'react';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { create } from 'zustand';
import { withDom, type HostElement } from '@/components/bots/chat/botMountedDom';
import type { HelperModelSelection } from '@/lib/helperModelSelection';

const initial = {providerID:'helper',modelID:'initial',revision:'original'};
const config = create<{settingsHelperModelSelection:HelperModelSelection;settingsOverrideKeys:string[];resetPersonalSettingsOverride:()=>Promise<void>}>(() => ({settingsHelperModelSelection:initial,settingsOverrideKeys:[],resetPersonalSettingsOverride:async()=>{}}));
mock.module('@/stores/useConfigStore',()=>({useConfigStore:config}));
const auth = await import('@/lib/authSession');
mock.module('@/lib/authSession',()=>({...auth,useAuthPrincipal:()=>({scope:'local-admin',role:'admin'})}));
mock.module('@/lib/i18n',()=>({useI18n:()=>({t:(key:string)=>key})}));
mock.module('./ModelSelector',()=>({ModelSelector:({disabled,onChange}:{disabled:boolean;onChange:(providerID:string,modelID:string)=>void})=><button disabled={disabled} onClick={()=>onChange('helper','chosen')}>Choose helper</button>}));
const errors:string[]=[];
const ui = await import('@/components/ui');
mock.module('@/components/ui',()=>({...ui,toast:{...ui.toast,error:(message:string)=>errors.push(message)}}));
const shared = await import('@/components/sections/shared');
mock.module('@/components/sections/shared',()=>({...shared,SettingsDetailSection:({children}:React.PropsWithChildren)=><div>{children}</div>}));
const {HelperModelSettings}=await import('./SessionDefaultsPage');
const originalFetch=globalThis.fetch;
const cryptoDescriptor=Object.getOwnPropertyDescriptor(globalThis,'crypto');
let resolveResponse:(response:Response)=>void;
let requests:Array<{body:{helperModelSelection:HelperModelSelection};method:string;csrf:string|null}>;
beforeEach(()=>{
 config.setState({settingsHelperModelSelection:initial,settingsOverrideKeys:[]});errors.length=0;requests=[];
 Object.defineProperty(globalThis,'crypto',{configurable:true,value:undefined});
 globalThis.fetch=Object.assign(mock(async(_input:RequestInfo|URL,init?:RequestInit)=>{
  requests.push({body:JSON.parse(String(init?.body)),method:init?.method??'GET',csrf:new Headers(init?.headers).get('x-devryan-csrf')});
  return new Promise<Response>(resolve=>{resolveResponse=resolve;});
 }),{preconnect:()=>{}});
});
afterEach(()=>{globalThis.fetch=originalFetch;if(cryptoDescriptor)Object.defineProperty(globalThis,'crypto',cryptoDescriptor);else Reflect.deleteProperty(globalThis,'crypto');});
const selector=(container:HostElement)=>container.find(node=>node.tagName==='BUTTON'&&node.textContent==='Choose helper');
for(const outcome of ['success','failure','wrong-revision','wrong-model'] as const)test(`helper save waits for delayed HTTP ${outcome} before releasing the selector and accepting a revision`,async()=>withDom(async container=>{
 const {createRoot}=await import('react-dom/client');const root=createRoot(container as unknown as Element);
 try{
  await act(async()=>root.render(<HelperModelSettings/>));
  await act(async()=>selector(container)?.click());
  expect(requests).toHaveLength(1);expect(requests[0]).toMatchObject({method:'PUT',csrf:'1'});
  expect(selector(container)?.hasAttribute('disabled')).toBe(true);expect(config.getState().settingsHelperModelSelection).toEqual(initial);
  const selection=requests[0].body.helperModelSelection;expect(selection).toMatchObject({providerID:'helper',modelID:'chosen'});expect(selection.revision).not.toBe('original');
  const response=outcome==='failure'?Response.json({},{status:500}):Response.json({helperModelSelection:{...selection,...(outcome==='wrong-revision'?{revision:'foreign'}:outcome==='wrong-model'?{modelID:'foreign'}:{})}});
  await act(async()=>{resolveResponse(response);});
  expect(selector(container)?.hasAttribute('disabled')).toBe(false);
  expect(config.getState().settingsHelperModelSelection).toEqual(outcome==='success'?selection:initial);
  expect(errors).toEqual(outcome==='success'?[]:['settings.sessionDefaults.helper.saveFailed']);
 }finally{await act(async()=>root.unmount());}
}));
test('UUID failure reports through the save finally owner without HTTP or a local selection change',async()=>withDom(async container=>{
 Object.defineProperty(globalThis,'crypto',{configurable:true,value:{randomUUID:()=>{throw Error('UUID failure');}}});
 const {createRoot}=await import('react-dom/client');const root=createRoot(container as unknown as Element);
 try{
  await act(async()=>root.render(<HelperModelSettings/>));await act(async()=>selector(container)?.click());
  expect(requests).toEqual([]);expect(selector(container)?.hasAttribute('disabled')).toBe(false);
  expect(config.getState().settingsHelperModelSelection).toEqual(initial);expect(errors).toEqual(['settings.sessionDefaults.helper.saveFailed']);
 }finally{await act(async()=>root.unmount());}
}));
