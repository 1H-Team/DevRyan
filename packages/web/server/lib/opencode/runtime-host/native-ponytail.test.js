import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { createNativePonytailOwner } from './native-ponytail.js';
const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-ponytail-'))); roots.push(root);
  const assertCommand = vi.fn(async () => {}), instructions = { lite: 'reviewed lite\n', full: 'reviewed full\n', ultra: 'reviewed ultra\n', review: 'reviewed review\n' };
  const options = { configDirectory: root, directories: [root], defaultMode: 'full', instructions, assertCommand };
  return { root, options, owner: createNativePonytailOwner(options), assertCommand,
    input: { command: 'ponytail', arguments: '', directory: root, sessionID: 'ses_fixture', permit: { token: 'a'.repeat(64), revision: 0, sessionID: 'ses_fixture' } } };
}
it('preserves all levels and exact instruction bytes across owner replacement without nested opencode paths', async () => {
  const f = await fixture(); expect(await f.owner.contextInstructions(f.root)).toBe('reviewed full\n');
  for (const mode of ['lite', 'ultra', 'review', 'off', 'full']) {
    expect(await f.owner.applyCommand({ ...f.input, arguments: ` ${mode.toUpperCase()} ` })).toEqual({ kind: 'changed', mode });
    const replacement = createNativePonytailOwner(f.options);
    expect(await replacement.readMode(f.root)).toBe(mode);
    expect(await replacement.contextInstructions(f.root)).toBe(mode === 'off' ? '' : f.options.instructions[mode]);
  }
  expect(f.owner.statePath).toBe(path.join(f.root, '.ponytail-active')); expect(f.assertCommand).toHaveBeenCalledTimes(10);
  expect(await f.owner.applyCommand(f.input)).toEqual({ kind: 'changed', mode: 'full' });
});
it('status/help/unrelated commands do not write, and fresh authority refusal leaves state intact', async () => {
  const f = await fixture();
  for (const arguments_ of ['status', 'help', 'add a normal mode toggle']) await f.owner.applyCommand({ ...f.input, arguments: arguments_ });
  await f.owner.applyCommand({ ...f.input, command: 'ponytail-help' });
  expect(f.assertCommand).not.toHaveBeenCalled(); await expect(fs.stat(f.owner.statePath)).rejects.toMatchObject({ code: 'ENOENT' });
  f.assertCommand.mockRejectedValueOnce(new Error('native_permit_invalid'));
  await expect(f.owner.applyCommand({ ...f.input, arguments: 'off' })).rejects.toThrow('native_permit_invalid');
  expect(await f.owner.readMode(f.root)).toBe('full');
  await expect(f.owner.applyCommand({ ...f.input, directory: path.join(f.root, 'unreviewed') })).rejects.toMatchObject({ code: 'native_ponytail_location_unreviewed' });
});
it('refuses state-file symlinks rather than altering an arbitrary file', async () => {
  const f = await fixture(), other = path.join(f.root, 'outside-state'); await fs.writeFile(other, 'full'); await fs.symlink(other, f.owner.statePath);
  await expect(f.owner.applyCommand({ ...f.input, arguments: 'off' })).rejects.toMatchObject({ code: 'ELOOP' });
  expect(await fs.readFile(other, 'utf8')).toBe('full');
});

it('keeps prior complete mode visible while final authorization is pending and refused', async () => {
  const f=await fixture(); await f.owner.applyCommand({...f.input,arguments:'lite'});
  let release; const held=new Promise(resolve=>{release=resolve;});
  let reached; const atCommit=new Promise(resolve=>{reached=resolve;});
  f.assertCommand.mockImplementationOnce(async()=>{}).mockImplementationOnce(async()=>{reached();await held;throw new Error('revoked_at_commit');});
  const outcome=f.owner.applyCommand({...f.input,arguments:'ultra'}).then(()=>null,error=>error);
  await atCommit;
  for(let index=0;index<20;index++) expect(await f.owner.readMode(f.root)).toBe('lite');
  release();expect((await outcome).message).toBe('revoked_at_commit');
  expect(await f.owner.readMode(f.root)).toBe('lite');
  expect((await fs.readdir(f.root)).filter(name=>name.includes('.tmp-'))).toEqual([]);
});
it('concurrent authorized commands never expose an empty or partial mode to readers', async () => {
  const f=await fixture();await f.owner.applyCommand({...f.input,arguments:'lite'});
  const observed=[];
  await Promise.all([
    Promise.all(['off','full','ultra','review'].map(arguments_=>f.owner.applyCommand({...f.input,arguments:arguments_}))),
    (async()=>{for(let index=0;index<40;index++)observed.push(await fs.readFile(f.owner.statePath,'utf8'));})(),
  ]);
  expect(observed.every(value=>['lite','off','full','ultra','review'].includes(value))).toBe(true);
});
it('refuses a mode file replaced by a symlink while bytes are staged', async () => {
  const f=await fixture(),outside=path.join(f.root,'outside');await fs.writeFile(outside,'full');
  f.assertCommand.mockImplementationOnce(async()=>{}).mockImplementationOnce(async()=>{await fs.symlink(outside,f.owner.statePath);});
  // Final authority must not bypass the state boundary either. The owner
  // rechecks immediately after authorization before the commit below.
  await expect(f.owner.applyCommand({...f.input,arguments:'off'})).rejects.toMatchObject({code:'ELOOP'});
  expect(await fs.readFile(outside,'utf8')).toBe('full');
});

it('preserves only standalone deactivation aliases and harmless status/help behavior',async()=>{
 const f=await fixture();
 for(const arguments_ of ['STOP PONYTAIL!','normal mode.'])expect(await f.owner.applyCommand({...f.input,arguments:arguments_})).toEqual({kind:'changed',mode:'off'});
 await f.owner.applyCommand({...f.input,arguments:'lite'});
 expect(await f.owner.applyCommand({...f.input,arguments:'add a normal mode toggle'})).toEqual({kind:'ignored'});
 expect(await f.owner.readMode(f.root)).toBe('lite');
});
