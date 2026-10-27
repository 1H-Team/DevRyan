import { describe, expect, test } from 'vitest';
import { createSessionActivityGate } from './session-activity-gate.js';
import { createSessionRetention, retentionTrees } from './session-retention.js';

const now = Date.now(), old = now - 90 * 86_400_000;
const row = (id, extra = {}) => ({ id, directory: '/fixture', time: { updated: old, created: old }, ...extra });
const recent = Array.from({ length: 5 }, (_, i) => row(`recent${i}`, { time: { updated: now } }));
const snapshot = (rows) => ({ protocol: 1, complete: true, instanceID: 'runtime-a', sessions: [...recent, ...rows] });

describe('retention admission and selection', () => {
  test('accepted asynchronous work holds admission after its HTTP response', async () => {
    const gate = createSessionActivityGate();
    const settle = gate.enter(['root', 'child']);
    // A 202 response does not call settle().
    expect(() => gate.hold(['child'])).toThrow('session_active');
    settle(); settle();
    const release = gate.hold(['root', 'child']);
    expect(() => gate.enter(['child'])).toThrow('session_retention_in_progress');
    release(); expect(() => gate.enter(['child'])()).not.toThrow();
  });
  test('connected unknown clients block; staged selection protects both rows until acknowledgement', () => {
    const gate = createSessionActivityGate();
    const close = gate.connect({ url: '/api/global/event?clientID=client_1234' });
    expect(() => gate.selections()).toThrow('client_selection_unknown');
    gate.select('client_1234', 'old', 1, true);
    gate.select('client_1234', 'new', 2);
    expect([...gate.selections()].sort()).toEqual(['new', 'old']);
    gate.select('client_1234', 'new', 2, true);
    expect([...gate.selections()]).toEqual(['new']);
    expect(() => gate.select('client_1234', 'old', 1, true)).toThrow('selection_superseded');
    close(); expect([...gate.selections()]).toEqual(['new']);
  });
  test('a descendant protects its whole tree, including ancestors', () => {
    const trees = retentionTrees(snapshot([row('root'), row('child', { parentID: 'root', share: { url: 'shared' } })]), { days: 30, now });
    expect(trees.find((tree) => tree.rootID === 'root').reason).toBe('shared_session');
  });
  test('unknown ancestors, cycles and truncated snapshots fail closed', () => {
    for (const data of [snapshot([row('child', { parentID: 'missing' })]),
      snapshot([row('one', { parentID: 'two' }), row('two', { parentID: 'one' })]), { ...snapshot([]), complete: false }]) {
      expect(() => retentionTrees(data, { days: 30, now })).toThrow('session_tree_incomplete');
    }
  });
  test('archived-only policy uses archive time and requires explicit opt-in', () => {
    const data = snapshot([row('archived', { time: { updated: old, archived: now } })]);
    expect(retentionTrees(data, { days: 30, now }).at(-1).reason).toBe('archive_policy');
    expect(retentionTrees(data, { days: 30, now, archivedOnly: true }).at(-1).reason).toBe('recent_session');
  });
});

function fixture(overrides={}) {
 const gate=createSessionActivityGate(),calls=[];
 const settings={autoDeleteEnabled:true,autoDeleteAfterDays:30,sessionRetentionAction:'archive'};
 const data=snapshot([row('root',{parentID:null}),row('child',{parentID:'root'})]);
 const native={readRetentionSnapshot:async()=>data,retainSessions:async input=>{calls.push(input);await input.authorize(input.members);return true;}};
 const retention=createSessionRetention({gate,readSettings:async()=>settings,isExclusive:()=>true,getDirectory:()=>'/fixture',
   openCodeClient:{generation:()=>2},getNativeRuntime:()=>native,protectedSessions:async()=>[],checkLedger:async()=>{},...overrides});
 return {retention,calls,settings,data,gate,native};
}
describe('server native retention',()=>{
 test('archives an eligible whole tree under host activity hold',async()=>{
  const f=fixture();f.native.retainSessions=async input=>{expect(()=>f.gate.enter(['child'])).toThrow('session_retention_in_progress');await input.authorize(input.members);f.calls.push(input);return true;};
  expect(await f.retention.run()).toMatchObject({completed:['root','child'],failed:[]});expect(f.calls[0]).toMatchObject({action:'archive',sessionID:'root'});
  expect(()=>f.gate.enter(['child'])()).not.toThrow();
 });
 test('new activity, selection, managed ownership and policy changes skip without cancelling',async()=>{
  const active=fixture(),settle=active.gate.enter(['child']);expect((await active.retention.run()).completed).toEqual([]);expect(active.calls).toEqual([]);settle();
  const selected=fixture();selected.gate.select('client_1234','child',1,true);expect((await selected.retention.run()).skipped).toContainEqual({id:'root',reason:'protected_session'});
  const managed=fixture({protectedSessions:async()=>['child']});expect((await managed.retention.run()).completed).toEqual([]);
  const changed=fixture();changed.native.retainSessions=async input=>{changed.settings.autoDeleteEnabled=false;await input.authorize(input.members);throw Error('must not mutate');};
  expect((await changed.retention.run()).skipped).toContainEqual({id:'root',reason:'retention_policy_changed'});
 });
 test('authoritative native member update and managed metadata block after the initial snapshot',async()=>{
  for(const mutation of [member=>({...member,time:{...member.time,updated:Date.now()}}),member=>({...member,metadata:{managed:true}})]){
   const f=fixture();f.native.retainSessions=async input=>{await input.authorize(input.members.map(member=>member.id==='child'?mutation(member):member));throw Error('must not mutate');};
   expect((await f.retention.run()).completed).toEqual([]);
  }
 });
 test('delete accepts only exact owned archival metadata and checks the ledger',async()=>{
  let checked=0;const f=fixture({checkLedger:async()=>{checked++;}});f.settings.sessionRetentionAction='delete';f.settings.sessionRetentionArchivedOnly=true;
  f.data.sessions=f.data.sessions.map(member=>['root','child'].includes(member.id)?{...member,time:{...member.time,archived:old},metadata:{devryan:{archive:{sessionID:member.id,at:old}}}}:member);
  expect((await f.retention.run()).completed).toEqual(['root','child']);expect(checked).toBeGreaterThan(0);
  const foreign=retentionTrees(snapshot([row('root',{metadata:{devryan:{archive:{sessionID:'foreign',at:old}}},time:{updated:old,archived:old}})]),{days:30,archivedOnly:true,now});
  expect(foreign.at(-1).reason).toBe('managed_session');
 });
 test('disabled, uncoordinated, absent native capability and wrong generation are typed skips',async()=>{
  for(const [overrides,reason]of [[{readSettings:async()=>({autoDeleteEnabled:false})},'disabled'],[{isExclusive:()=>false},'runtime_uncoordinated'],[{getNativeRuntime:()=>null},'capability_absent'],[{openCodeClient:{generation:()=>1}},'opencode_generation_invalid']]){
   const f=fixture(overrides);expect((await f.retention.run()).skipped).toContainEqual({id:null,reason});expect(f.calls).toEqual([]);
  }
 });
});
