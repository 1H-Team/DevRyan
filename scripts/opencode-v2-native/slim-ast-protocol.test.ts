import {test,expect} from 'bun:test';
import {Schema} from 'effect';
import {WorkerInput} from '../../packages/web/server/lib/opencode/runtime-host/worker-protocol.ts';

test('AST worker assets are required only on exact reviewed AST tool requests',()=>{
 const common={protocol:1,input:{},directory:'/private/view',projectDirectory:'/private/view',logicalDirectory:'/logical/project',
  logicalProjectDirectory:'/logical/project',scratchDirectory:'/private/scratch',config:{formatter:false},
  context:{sessionID:'ses_ast',messageID:'msg_ast',agent:'builder',id:'call_ast'}};
 const decode=(input:unknown)=>Schema.decodeUnknownSync(WorkerInput)(input,{onExcessProperty:'error'});
 const reviewedAst={path:'/artifacts/DevRyan-ast-grep-darwin-arm64',sha256:'a'.repeat(64)};
 for(const tool of ['ast_grep_search','ast_grep_replace'] as const){
  expect(JSON.stringify(decode({...common,tool,reviewedAst}))).toBe(JSON.stringify({...common,tool,reviewedAst}));
  expect(()=>decode({...common,tool})).toThrow();
  expect(()=>decode({...common,tool,reviewedAst:{...reviewedAst,download:'https://untrusted.invalid'}})).toThrow();
 }
 for(const tool of ['write','edit','patch'] as const){
  expect(JSON.stringify(decode({...common,tool}))).toBe(JSON.stringify({...common,tool}));
  expect(()=>decode({...common,tool,reviewedAst})).toThrow();
 }
 expect(()=>decode({...common,tool:'foreign.ast_grep_search',reviewedAst})).toThrow();
});
