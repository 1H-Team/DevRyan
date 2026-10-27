import { expect, test, vi } from 'vitest';
import { awaitVerificationPublications, isVerificationCommand } from './native-verification-order.js';
const input = command => ({kind:'shell', directory:'/project',sessionID:'s',messageID:'m',callID:'check',authorization:{input:{input:{command}}}});
const parts = [{type:'tool',tool:'edit',callID:'edit'}];
test.each(['bun test a.test.ts', 'npm run build', 'PW_EXTERNAL_SERVER=1 npx playwright test', 'sleep 3; bunx vitest run', 'tsc --noEmit', 'bun run validate', 'npm run typecheck'])('verification cannot snapshot an unpublished edit: %s', async command => {
  expect(isVerificationCommand(command)).toBe(true);
  await expect(awaitVerificationPublications({input:input(command),parts,leaseForCall:async()=>({state:'ready'}),activeJob:()=>undefined})).rejects.toMatchObject({code:'native_verification_publication_pending'});
});
test('waits through durable publication, including delayed receipt settlement', async()=>{
  let publish; let state='ready';
  const settled=new Promise(resolve=>{publish=()=>{state='published';resolve();};});
  const done=vi.fn();
  const pending=awaitVerificationPublications({input:input('bun test'),parts,leaseForCall:async()=>({state}),activeJob:()=>({settled})}).then(done);
  await Promise.resolve(); expect(done).not.toHaveBeenCalled();
  publish();await pending;expect(done).toHaveBeenCalledOnce();
});
test('unrelated commands remain parallel and failed publication stays blocking', async()=>{
  const leaseForCall=vi.fn(async()=>({state:'cancelled'}));
  await awaitVerificationPublications({input:input('rg name src'),parts,leaseForCall,activeJob:()=>undefined});
  expect(leaseForCall).not.toHaveBeenCalled();
  await expect(awaitVerificationPublications({input:input('bun test'),parts,leaseForCall,activeJob:()=>({settled:Promise.resolve()})})).rejects.toMatchObject({code:'native_verification_publication_pending'});
});
