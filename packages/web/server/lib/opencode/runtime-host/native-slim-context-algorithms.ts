import type * as ReviewedSlim from '../../../../runtime/reviewed-inputs/slim-2.2.25/dist/server/index.js';
import type {SessionRetry} from '@opencode/plugin/effect/session';

export interface NativeSlimRetryOwners {
 /** Existing recovery owner must hold its canonical generation/budget transaction
  * across this selector and its deferred one-attempt reservation. Native retry must stop; canonical settlement precedes dispatch. No independent retry state. */
 readonly withRecovery:(event:SessionRetry,choose:(state:ReviewedSlim.ReviewedSlimFallbackInput)=>ReviewedSlim.ReviewedSlimFallbackResult)=>Promise<void>;
 readonly assertCurrent:(event:SessionRetry)=>Promise<void>;
}
export function createOwnedSlimRetrySelector(originals:typeof ReviewedSlim,owners:NativeSlimRetryOwners){
 return async(event:SessionRetry)=>{
  await owners.assertCurrent(event);
  if(!originals.isReviewedSlimFailoverError(event.error))return;
  await owners.withRecovery(event,state=>originals.selectReviewedSlimFallback(state));
  await owners.assertCurrent(event);
 };
}
export interface NativeSlimTaskBoardOwners {
 /** Exact existing task owner. Its mutation fence covers original reconciliation
  * callbacks and durable commit. The renderer owns only transient prompt history. */
 readonly withTaskState:(action:()=>Promise<void>)=>Promise<void>;
 readonly assertCurrent:()=>Promise<void>;
 readonly presentation:ReviewedSlim.ReviewedSlimBoardOwners;
}
export function createOwnedSlimTaskBoardRenderer(originals:typeof ReviewedSlim,owners:NativeSlimTaskBoardOwners){
 const renderer=originals.createReviewedSlimTaskBoardRenderer(owners.presentation);
 return {transform:async(input:Record<string,unknown>,output:Record<string,unknown>)=>{
  await owners.assertCurrent();
  await owners.withTaskState(()=>renderer.transform(input,output));
  await owners.assertCurrent();
 },clearSession:renderer.clearSession};
}
