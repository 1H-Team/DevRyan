import request from '../../../test-supertest.js';
import { expect, test, vi } from 'vitest';
import vm from 'node:vm';
import { createRuntimeBundleRecoveryApplication } from './runtime-bundle-recovery.js';

const binding = { descriptor: { bundleID: 'A', launch: { privatePath: '/must/not/expose' } },
  selection: { revision: 3, selectedBundleID: 'A', previousBundleID: 'B', reconciliationRequired: true } };

test('held recovery has an inspectable HTTP listener and no provider/session mutation surface', async () => {
  const application = createRuntimeBundleRecoveryApplication({ binding });
  const startProvider = vi.fn();
  const runtime = await application.startWebUiServer({ port: 0, attachSignals: false, ensureBotRuntimeReady: startProvider });
  try {
    expect(runtime.isReady()).toBe(false); expect(runtime.getOpenCodePort()).toBeNull();
    expect((await request(runtime.expressApp).get('/')).text).toContain('Runtime recovery is required');
    const inspected = await request(runtime.expressApp).get('/api/runtime/bundle');
    expect(inspected.status).toBe(200);
    expect(inspected.body).toMatchObject({ bundleID: 'A', previousBundleID: 'B', state: 'held', revision: 3 });
    expect(JSON.stringify(inspected.body)).not.toContain('/must/not/expose');
    expect((await request(runtime.expressApp).get('/health')).status).toBe(503);
    expect((await request(runtime.expressApp).post('/api/session').send({ title: 'forbidden' })).status).toBe(503);
    await expect(runtime.runtimeBundle.rollback({ expectedRevision: 3 })).rejects.toMatchObject({ code: 'bundle_rollback_reconciliation_required' });
    expect(startProvider).not.toHaveBeenCalled();
  } finally { await runtime.stop(); }
});

test('held recovery does not reuse a requested remote bind or start a saved tunnel', async () => {
  const application = createRuntimeBundleRecoveryApplication({ binding });
  await expect(application.startWebUiServer({ host: '0.0.0.0', port: 0, attachSignals: false })).rejects.toMatchObject({ code: 'bundle_recovery_loopback_required' });
});

test('pending B remains passive and only the owned local server handle can delegate Resume B',async()=>{
 const resume=vi.fn(async()=>({state:'restart_required',revision:3,restartRequired:true}));
 const application=createRuntimeBundleRecoveryApplication({binding:{...binding,controlRoot:'/owned/control',admission:'held',selection:{...binding.selection,revision:2,selectedBundleID:'B',previousBundleID:'A',reconciliationRequired:false},descriptor:{bundleID:'B'},rollbackRecovery:{reason:'bundle_rollback_pending',candidateBundleID:'B',targetBundleID:'A'}},resume});
 const runtime=await application.startWebUiServer({port:0,attachSignals:false});
 try{
  expect((await request(runtime.expressApp).get('/api/runtime/bundle')).body).toMatchObject({state:'held',reconciliationRequired:true});
  expect((await request(runtime.expressApp).post('/api/runtime/bundle/resume').send({expectedRevision:2})).status).toBe(503);
  expect(resume).not.toHaveBeenCalled();await expect(runtime.runtimeBundle.resume({expectedRevision:2})).resolves.toMatchObject({revision:3});
  expect(resume).toHaveBeenCalledExactlyOnceWith({controlRoot:'/owned/control',input:{expectedRevision:2}});
 }finally{await runtime.stop();}
});

test('the actual recovery page preserves finite Electron errors without exposing transport messages', async () => {
  const application = createRuntimeBundleRecoveryApplication({ binding: { ...binding, admission: 'held',
    rollbackRecovery: { candidateBundleID: 'A' } } });
  const runtime = await application.startWebUiServer({ port: 0, attachSignals: false });
  try {
    const html = (await request(runtime.expressApp).get('/')).text;
    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    for (const [error, expected] of [
      [new Error("Error invoking remote method 'openchamber:invoke': Error: bundle_recovery_proof_required"), 'bundle_recovery_proof_required'],
      [Object.assign(new Error('fixture'), { code: 'bundle_selection_revision_conflict' }), 'bundle_selection_revision_conflict'],
      [new Error("Error invoking remote method 'foreign:invoke': Error: bundle_recovery_proof_required"), 'bundle_recovery_failed'],
      [new Error("Error invoking remote method 'openchamber:invoke': Error: bundle_recovery_proof_required\nprivate fixture"), 'bundle_recovery_failed'],
      [new Error('private fixture bundle_recovery_proof_required'), 'bundle_recovery_failed'],
    ]) {
      let click;
      const button = { hidden: true, disabled: false, addEventListener: (_event, action) => { click = action; } };
      const result = { textContent: '' };
      const invoke = vi.fn(async () => { throw error; });
      vm.runInNewContext(script, { window: { __TAURI__: { core: { invoke } } },
        document: { getElementById: id => id === 'resume' ? button : result } });
      expect(button.hidden).toBe(false); await click();
      expect(invoke).toHaveBeenCalledExactlyOnceWith('desktop_runtime_bundle_resume', { expectedRevision: 3 });
      expect(result.textContent).toBe(expected); expect(button.disabled).toBe(false);
    }
  } finally { await runtime.stop(); }
});
