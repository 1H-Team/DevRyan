import assert from 'node:assert/strict';
import {test} from 'node:test';
import {assertQaDesktopAppearance,selectQaDesktopAppearance,qaDesktopAppearanceExpression} from './appearance.mjs';

const fixture=(initial,{respond=true,button=true}={})=>{
  const state={theme:initial,clicks:[],waits:[]};
  const document={documentElement:{classList:{contains:()=>state.theme==='dark'}},querySelectorAll:()=>button?[{
    getAttribute:()=>state.theme==='dark'?'Switch to Light Mode':'Switch to Dark Mode',disabled:false,
    getBoundingClientRect:()=>({width:24,height:24}),
  }]:[]};
  const cdp={send:async(method,{expression})=>{
    assert.equal(method,'Runtime.evaluate');
    return {result:{value:new Function('document',`return ${expression}`)(document)}};
  }};
  const ui={waitFor:async(_label,read)=>{const value=await read();assert.ok(value,'Missing visible theme control');return value;},
    click:async input=>{state.clicks.push(input);if(respond)state.theme=input.label==='Switch to Dark Mode'?'dark':'light';},
    waitExpression:async(_label,expression)=>{state.waits.push(expression);assert.equal(new Function('document',`return ${expression}`)(document),true,'Theme did not settle');}};
  return {state,document,cdp,ui};
};

test('desktop appearance uses the visible theme button in both directions and verifies its new state',async()=>{
  for(const [initial,theme,label] of [['light','dark','Switch to Dark Mode'],['dark','light','Switch to Light Mode']]){
    const f=fixture(initial),result=await selectQaDesktopAppearance({...f,theme});
    assert.deepEqual(f.state.clicks,[{label}]);assert.equal(result.initial,initial);assert.equal(result.observed,theme);
    assert.equal(result.clicked,true);assert.equal(result.source,'actual-sidebar-theme-button');
  }
});

test('already selected appearance leaves its working control unchanged',async()=>{
  const f=fixture('dark'),result=await selectQaDesktopAppearance({...f,theme:'dark'});
  assert.deepEqual(f.state.clicks,[]);assert.equal(result.clicked,false);assert.equal(result.observed,'dark');
});

test('missing control or an ignored theme change cannot pass appearance selection',async()=>{
  await assert.rejects(selectQaDesktopAppearance({...fixture('light',{button:false}),theme:'dark'}),/Missing visible theme control/);
  await assert.rejects(selectQaDesktopAppearance({...fixture('light',{respond:false}),theme:'dark'}),/Theme did not settle/);
  await assert.rejects(selectQaDesktopAppearance({...fixture('light'),theme:'system'}),/Explicit desktop theme/);
});

test('screenshot assertion rejects a theme lost after reload without repairing the evidence',async()=>{
  const f=fixture('light');await selectQaDesktopAppearance({...f,theme:'dark'});f.state.theme='light';
  await assert.rejects(assertQaDesktopAppearance({...f,theme:'dark'}),/Rendered desktop theme differs/);
  assert.equal(f.state.clicks.length,1,'Capture validation must not silently switch themes after reload');
});

test('appearance projection requires a real enabled nonzero control',()=>{
  const project=new Function('document',`return ${qaDesktopAppearanceExpression}`);
  for(const [disabled,width,height] of [[true,24,24],[false,0,24],[false,24,0]]){
    const document={documentElement:{classList:{contains:()=>false}},querySelectorAll:()=>[{
      getAttribute:()=> 'Switch to Dark Mode',disabled,getBoundingClientRect:()=>({width,height}),
    }]};
    assert.equal(project(document).toggleReady,false);
  }
});
