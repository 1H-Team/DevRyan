import { test, expect } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { parseWindowsFileIdentity, parseWindowsPrivateFileRead, parseWindowsPrivatePublication, parseWindowsPrivateDeletion,
  parseWindowsPublicationState, parseWindowsNamespaceDurability, parseWindowsPrivateTree, parseWindowsLargePrivateFile,
  parseWindowsPublicationPruning, windowsPublicationExpected, createWindowsPrivateFileOwner } from './windows-private-files.js';
import {isWindowsPrivateControlName,parseWindowsPrivateTreeCopy,parseWindowsNativeImportReceipt,parseWindowsNativeImportFrame} from './windows-private-files.js';

test('copy scope recognizes exact native control identities and refuses malformed copy proofs',()=>{
 for(const name of ['.DevRyan-publication.lock','.DEVRYAN-publication.INTENT',`.DevRyan-publication-${'A'.repeat(32)}.receipt`,`.DevRyan-publication-${'b'.repeat(32)}.backup`,`.DevRyan-publication-${'c'.repeat(32)}.candidate`])expect(isWindowsPrivateControlName(name)).toBe(true);
 for(const name of ['.DevRyan-publication-not-a-control','.DevRyan-publication-lock',`.DevRyan-publication-${'g'.repeat(32)}.receipt`,'.DevRyan-publication.intent.extra',null])expect(isWindowsPrivateControlName(name)).toBe(false);
 const token=`${'a'.repeat(16)}:${'b'.repeat(32)}:${'c'.repeat(64)}:4:2`;
 const receipt={protocol:'devryan.windows-private-tree-copy/1',sourceToken:token,destinationToken:token,sourceParentVolume:'a'.repeat(16),sourceParentFileId:'b'.repeat(32),destinationParentVolume:'d'.repeat(16),destinationParentFileId:'e'.repeat(32),namespaceFlushed:true,exclusions:'runtime-bundle'};
 expect(parseWindowsPrivateTreeCopy(JSON.stringify(receipt))).toEqual(receipt);
 for(const change of [{exclusions:'all'},{namespaceFlushed:false},{sourceToken:[token]},{destinationToken:token.replace(':4:2',':04:2')},{sourceParentFileId:null},{extra:true}])expect(()=>parseWindowsPrivateTreeCopy(JSON.stringify({...receipt,...change}))).toThrow('private_windows_file_unverified');
});

test('native import frames bind fixed operation, complete job settlement and exact binary output lengths',()=>{
 const prefix=`${'a'.repeat(16)}:${'b'.repeat(32)}:${'c'.repeat(64)}`;
 const receipt={protocol:'devryan.windows-native-import/1',nonce:'d'.repeat(32),operation:'migrate',rootExclusions:'none',mutating:true,controllerToken:`${prefix}:4`,gitToken:null,rootToken:`${prefix}:4:2`,environmentToken:null,namespaceFlushed:true,jobSettled:true,exitCode:0};
 expect(parseWindowsNativeImportReceipt(JSON.stringify(receipt))).toEqual(receipt);
 const stdout=Buffer.from([0,255,10,123,125]),stderr=Buffer.from('untrusted receipt-looking text\n');
 const frame=Buffer.concat([Buffer.from(JSON.stringify(receipt)+'\n'+stdout.length+':'+stderr.length+'\n'),stdout,stderr]);
 const parsed=parseWindowsNativeImportFrame(frame);expect(parsed.receipt).toEqual(receipt);expect(parsed.stdout).toEqual(stdout);expect(parsed.stderr).toEqual(stderr);
 const relocation={...receipt,operation:'relocate-bundle-harness',rootExclusions:'runtime-bundle',mutating:false,gitToken:`${prefix}:4`,environmentToken:`${prefix}:0:1`};
 expect(parseWindowsNativeImportReceipt(JSON.stringify(relocation))).toEqual(relocation);
 for(const change of [{operation:'shell'},{rootExclusions:'runtime-bundle'},{mutating:false},{gitToken:`${prefix}:4`},{jobSettled:false},{exitCode:1},{namespaceFlushed:false},{nonce:[]},{controllerToken:[]},{environmentToken:[]},{extra:true}])expect(()=>parseWindowsNativeImportReceipt(JSON.stringify({...receipt,...change}))).toThrow('private_windows_file_unverified');
 for(const raw of [frame.subarray(0,frame.length-1),Buffer.concat([frame,Buffer.from('x')]),Buffer.from(JSON.stringify(receipt)+'\n05:0\nxxxxx'),Buffer.from(JSON.stringify(receipt)+'\n1048577:0\n'),Buffer.from(JSON.stringify(receipt)+'\n5:0\n'),Buffer.from('x'.repeat(4097)+'\n0:0\n')])expect(()=>parseWindowsNativeImportFrame(raw)).toThrow('private_windows_file_unverified');
});

test('SQLite and importer leases retain exact child ownership until complete framed settlement',()=>{
 const source=`
 import assert from 'node:assert/strict';import {EventEmitter}from'node:events';import {PassThrough}from'node:stream';
 Object.defineProperty(process,'platform',{value:'win32'});
 const {beginWindowsSqliteOutput,beginWindowsNativeImport}=await import(${JSON.stringify(new URL('./windows-private-files.js',import.meta.url).href)});
 const fixture=()=>{const child=new EventEmitter();child.pid=17;child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();let killed=0;const chunks=[];child.stdin.on('data',bytes=>chunks.push(bytes));child.kill=()=>{killed++;queueMicrotask(()=>child.emit('close',125));};return{child,chunks,killed:()=>killed};};
 const file={protocol:'devryan.windows-update-file/1',token:'a'.repeat(16)+':'+ 'b'.repeat(32)+':'+ 'c'.repeat(64)+':4096',size:4096};
 const sqlite=fixture();const lease=beginWindowsSqliteOutput('C:\\\\private\\\\owner.exe','C:\\\\private\\\\sqlite','copy.db',{spawnProcess:()=>sqlite.child,timeoutMs:100,terminationMs:10});
 assert.throws(()=>lease.assertHeld());sqlite.child.stdout.write(JSON.stringify({protocol:'devryan.windows-sqlite-output/1',status:'held'})+'\\n');await lease.ready;lease.assertHeld();
 const committed=lease.commit();assert.equal(Buffer.concat(sqlite.chunks).toString(),'commit\\n');sqlite.child.stdout.write(JSON.stringify(file)+'\\n');sqlite.child.emit('close',0);assert.deepEqual(await committed,file);assert.throws(()=>lease.assertHeld());
 const token=file.token+':2',nonce='d'.repeat(32),options={controller:'C:\\\\artifact\\\\DevRyan-native-controller.exe',controllerSha256:'c'.repeat(64),expectedArtifactToken:token,root:'C:\\\\private\\\\bundle',expectedRootToken:token,nativeReceipt:'C:\\\\private\\\\receipts\\\\'+nonce+'.json',nonce};
 const imported=fixture();let args;const importer=beginWindowsNativeImport('C:\\\\artifact\\\\owner.exe',options,{spawnProcess:(_launcher,values)=>{args=values;return imported.child;},timeoutMs:100,terminationMs:10});
 assert.equal(args[0],'--hold-native-import');assert.deepEqual(args.slice(-4),['migrate','none','1',options.root]);
 imported.child.stdout.write(JSON.stringify({protocol:'devryan.windows-native-import/1',status:'held'})+'\\n');await importer.ready;await importer.writeRequest(Buffer.from('{}\\n'));assert.throws(()=>importer.writeRequest(Buffer.from('{}')));const result=importer.finish();
 const receipt={protocol:'devryan.windows-native-import/1',nonce,operation:'migrate',rootExclusions:'none',mutating:true,controllerToken:file.token,gitToken:null,rootToken:token,environmentToken:null,namespaceFlushed:true,jobSettled:true,exitCode:0};
 const stdout=Buffer.from('{"ok":true}\\n'),stderr=Buffer.from([255,0]);imported.child.stdout.write(Buffer.concat([Buffer.from(JSON.stringify(receipt)+'\\n'+stdout.length+':'+stderr.length+'\\n'),stdout,stderr]));imported.child.emit('close',0);const settled=await result;assert.deepEqual(settled.stdout,stdout);assert.deepEqual(settled.stderr,stderr);assert.deepEqual(settled.receipt,receipt);assert.equal(imported.killed(),0);
 const cancelled=fixture();const cancelling=beginWindowsNativeImport('C:\\\\artifact\\\\owner.exe',options,{spawnProcess:()=>cancelled.child,timeoutMs:100,terminationMs:10});cancelled.child.stdout.write(JSON.stringify({protocol:'devryan.windows-native-import/1',status:'held'})+'\\n');await cancelling.ready;await cancelling.writeRequest(Buffer.from('{}'));assert.equal(await cancelling.cancel(),null);assert.equal(cancelled.killed(),1);assert.throws(()=>cancelling.assertHeld());
 assert.throws(()=>beginWindowsNativeImport('C:\\\\artifact\\\\owner.exe',{...options,operation:'shell'}));assert.throws(()=>beginWindowsNativeImport('C:\\\\artifact\\\\owner.exe',{...options,operation:'relocate-bundle-harness',rootExclusions:'runtime-bundle'}));
 `;
 expect(()=>execFileSync('node',['--input-type=module','-e',source],{stdio:'pipe',timeout:5000})).not.toThrow();
});

test('explicit ledger receipts allow 64 MiB while ordinary private owners keep their 16 MiB boundary', () => {
  const maximum = 64 * 1024 * 1024;
  const value = { protocol: 'devryan.windows-private-publication/1', status: 'published', nonce: 'a'.repeat(32),
    parentVolume: 'b'.repeat(16), parentFileId: 'c'.repeat(32), volume: 'b'.repeat(16), fileId: 'd'.repeat(32),
    size: maximum, sha256: 'e'.repeat(64), namespaceFlushed: true };
  expect(createWindowsPrivateFileOwner({ launcher: 'fixture' }).maxBytes).toBe(16 * 1024 * 1024);
  expect(createWindowsPrivateFileOwner({ launcher: 'fixture', maxBytes: maximum }).maxBytes).toBe(maximum);
  expect(() => parseWindowsPrivatePublication(JSON.stringify(value))).toThrow();
  expect(parseWindowsPrivatePublication(JSON.stringify(value), maximum).size).toBe(maximum);
  expect(() => parseWindowsPrivatePublication(JSON.stringify({ ...value, size: maximum + 1 }), maximum)).toThrow();
  const deletion = { protocol: 'devryan.windows-private-deletion/1', status: 'deleted', nonce: value.nonce,
    parentVolume: value.volume, parentFileId: value.parentFileId, oldToken: `${value.volume}:${value.fileId}:${value.sha256}:${maximum}`, namespaceFlushed: true };
  expect(() => parseWindowsPrivateDeletion(JSON.stringify(deletion))).toThrow();
  expect(parseWindowsPrivateDeletion(JSON.stringify(deletion), maximum).oldToken).toBe(deletion.oldToken);
  const identity = { protocol: 'devryan.windows-file-identity/1', volume: value.volume, fileId: value.fileId,
    type: 'file', reparsePoint: false, linkCount: 1, currentOwner: true, privateAcl: true };
  const bytes = Buffer.alloc(16 * 1024 * 1024 + 1), proof = { identity, bytes };
  const frame = Buffer.concat([Buffer.from(JSON.stringify(identity) + '\n'), bytes]);
  expect(() => parseWindowsPrivateFileRead(frame)).toThrow();
  expect(parseWindowsPrivateFileRead(frame, maximum).bytes.length).toBe(bytes.length);
  expect(() => windowsPublicationExpected(proof)).toThrow();
  expect(windowsPublicationExpected(proof, maximum).endsWith(`:${bytes.length}`)).toBe(true);
  for (const bound of [0, -1, 1.5, maximum + 1, Infinity]) {
    expect(() => createWindowsPrivateFileOwner({ launcher: 'fixture', maxBytes: bound })).toThrow();
    expect(() => parseWindowsPrivatePublication(JSON.stringify(value), bound)).toThrow();
  }
});

test('Windows tree, stream and pruning receipts enforce types, canonical tokens and native bounds', () => {
  const prefix = `${'a'.repeat(16)}:${'b'.repeat(32)}:${'c'.repeat(64)}`;
  const tree = { protocol: 'devryan.windows-update-tree/1', token: `${prefix}:4:2`, namespaceFlushed: true };
  expect(parseWindowsPrivateTree(JSON.stringify(tree), true)).toBe(tree.token);
  for (const token of [[tree.token], null, `${prefix}:04:2`, `${prefix}:4:02`, `${prefix}:4:0`, `${prefix}:${8 * 1024 ** 3 + 1}:2`, `${prefix}:4:65537`]) {
    expect(() => parseWindowsPrivateTree(JSON.stringify({ ...tree, token }), true)).toThrow('private_windows_file_unverified');
  }
  expect(() => parseWindowsPrivateTree(JSON.stringify(tree), false)).toThrow();
  const file = { protocol: 'devryan.windows-update-file/1', token: `${prefix}:4`, size: 4 };
  expect(parseWindowsLargePrivateFile(JSON.stringify(file))).toEqual(file);
  for (const change of [{ token: [file.token] }, { token: `${prefix}:04` }, { size: 3 }, { size: 1.5 }, { extra: true },
    { token: `${prefix}:${8 * 1024 ** 3 + 1}`, size: 8 * 1024 ** 3 + 1 }]) {
    expect(() => parseWindowsLargePrivateFile(JSON.stringify({ ...file, ...change }))).toThrow('private_windows_file_unverified');
  }
  const pruning = { protocol: 'devryan.windows-publication-pruning/1', retained: 9, pruned: 10, namespaceFlushed: true };
  expect(parseWindowsPublicationPruning(JSON.stringify(pruning))).toEqual(pruning);
  for (const change of [{ retained: 34 }, { retained: -1 }, { pruned: 4097 }, { pruned: 0.5 }, { namespaceFlushed: false }, { extra: true }]) {
    expect(() => parseWindowsPublicationPruning(JSON.stringify({ ...pruning, ...change }))).toThrow('private_windows_file_unverified');
  }
});

test('Windows stream keeps a bounded exact-child lifetime after held and refuses unconfirmed termination', () => {
  const source = `
    import assert from 'node:assert/strict';
    import { EventEmitter } from 'node:events';
    import { PassThrough } from 'node:stream';
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const { beginWindowsPrivateStream } = await import(${JSON.stringify(new URL('./windows-private-files.js', import.meta.url).href)});
    const held = JSON.stringify({protocol:'devryan.windows-update-download/1',status:'held'}) + '\\n';
    const receipt = {protocol:'devryan.windows-update-file/1',token:'a'.repeat(16)+':'+ 'b'.repeat(32)+':'+ 'c'.repeat(64)+':4',size:4};
    const fixture = ({ closeOnKill = true, killError = false, timeoutMs = 20, terminationMs = 10 } = {}) => {
      const child = new EventEmitter(); child.pid = 471; child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      let killed = 0;
      child.kill = signal => { assert.equal(signal, 'SIGKILL'); killed++; if (killError) queueMicrotask(() => child.emit('error', Object.assign(new Error('kill refused'), {code:'EPERM'}))); if (closeOnKill) queueMicrotask(() => child.emit('close', 125)); return true; };
      const stream = beginWindowsPrivateStream('C:\\\\private\\\\owner.exe','C:\\\\private\\\\record.bin', {offset:0,maximum:4,expected:'absent'},
        {spawnProcess:()=>child,timeoutMs,terminationMs});
      return {child,stream,killed:()=>killed};
    };
    const timed = fixture(); timed.child.stdout.write(held); await timed.stream.ready;
    await assert.rejects(timed.stream.finish(), {code:'private_windows_stream_timeout'}); assert.equal(timed.killed(),1);
    await assert.rejects(timed.stream.write(Buffer.from('later')), {code:'private_windows_stream_timeout'});
    const unknown = fixture({closeOnKill:false}); unknown.child.stdout.write(held); await unknown.stream.ready;
    await assert.rejects(unknown.stream.finish(), {code:'private_windows_stream_termination_unconfirmed'}); assert.equal(unknown.killed(),1);
    unknown.child.emit('close',125);
    const killFailed = fixture({closeOnKill:false,killError:true}); killFailed.child.stdout.write(held); await killFailed.stream.ready;
    await assert.rejects(killFailed.stream.cancel(), {code:'private_windows_stream_termination_unconfirmed'}); assert.equal(killFailed.killed(),1);
    killFailed.child.emit('close',125);
    const cancelled = fixture({timeoutMs:100}); cancelled.child.stdout.write(held); await cancelled.stream.ready;
    assert.equal(await cancelled.stream.cancel(),null); assert.equal(cancelled.killed(),1);
    const unfinished = fixture({closeOnKill:false,timeoutMs:100}); unfinished.child.stdout.write(held); await unfinished.stream.ready;
    await assert.rejects(unfinished.stream.cancel(), {code:'private_windows_stream_termination_unconfirmed'}); assert.equal(unfinished.killed(),1);
    unfinished.child.emit('close',125);
    const bad = fixture(); bad.child.stdout.write('{"status":"held"}\\n');
    await assert.rejects(bad.stream.ready, {code:'private_windows_file_unverified'}); await assert.rejects(bad.stream.finish()); assert.equal(bad.killed(),1);
    const completed = fixture(); completed.child.stdout.write(held); await completed.stream.ready;
    const result = completed.stream.finish(); completed.child.stdout.write(JSON.stringify(receipt)+'\\n'); completed.child.emit('close',0);
    assert.deepEqual(await result,receipt); await new Promise(resolve=>setTimeout(resolve,35)); assert.equal(completed.killed(),0);
    const spawnError = fixture(); delete spawnError.child.pid; const waiting = spawnError.stream.ready;
    spawnError.child.emit('error',Object.assign(new Error('spawn refused'),{code:'EACCES'}));
    await assert.rejects(waiting,{code:'EACCES'}); await assert.rejects(spawnError.stream.finish(),{code:'EACCES'});
    await new Promise(resolve=>setTimeout(resolve,35)); assert.equal(spawnError.killed(),0);
  `;
  expect(() => execFileSync('node', ['--input-type=module', '-e', source], { stdio: 'pipe', timeout: 5000 })).not.toThrow();
});

test('Windows identity receipts reject guessed, widened and malformed shapes', () => {
  const identity = { protocol: 'devryan.windows-file-identity/1', volume: '0123456789abcdef',
    fileId: '0123456789abcdef0123456789abcdef', type: 'file', reparsePoint: false,
    linkCount: 1, currentOwner: true, privateAcl: true };
  expect(parseWindowsFileIdentity(JSON.stringify(identity))).toEqual(identity);
  for (const changed of [{ extra: true }, { protocol: 'other' }, { volume: null }, { volume: 1234567890123456 },
    { fileId: 'short' }, { fileId: [identity.fileId] },
    { type: 'symlink' }, { reparsePoint: 0 }, { currentOwner: 'true' }, { privateAcl: null },
    { linkCount: 0 }, { linkCount: 1.5 }, { linkCount: Number.MAX_SAFE_INTEGER + 1 }]) {
    expect(() => parseWindowsFileIdentity(JSON.stringify({ ...identity, ...changed }))).toThrow('private_windows_file_unverified');
  }
  for (const raw of ['null', '[]', '{}', '{', ' '.repeat(4097)]) {
    expect(() => parseWindowsFileIdentity(raw)).toThrow('private_windows_file_unverified');
  }
});

test('Windows publication receipts bind parent, staged bytes, nonce and namespace durability', () => {
  const value = { protocol: 'devryan.windows-private-publication/1', status: 'published', nonce: 'a'.repeat(32),
    parentVolume: 'b'.repeat(16), parentFileId: 'c'.repeat(32), volume: 'b'.repeat(16), fileId: 'd'.repeat(32),
    size: 4, sha256: 'e'.repeat(64), namespaceFlushed: true };
  expect(parseWindowsPrivatePublication(JSON.stringify(value))).toEqual(value);
  for (const change of [{ extra: true }, { volume: 'f'.repeat(16) }, { size: -1 }, { size: 16 * 1024 * 1024 + 1 },
    { size: 1.5 }, { namespaceFlushed: false }, { parentFileId: 'short' }, { nonce: null }, { sha256: 'bad' }, { status: 'pending' }]) {
    expect(() => parseWindowsPrivatePublication(JSON.stringify({ ...value, ...change }))).toThrow('private_windows_file_unverified');
  }
  expect(() => parseWindowsPrivatePublication(' '.repeat(4097))).toThrow();
});

test('publication state never upgrades a missing or partial receipt to success', () => {
  for (const status of ['none', 'pending', 'published', 'deleted']) {
    const value = { protocol: 'devryan.windows-publication-state/1', status, nonce: status === 'none' ? null : 'a'.repeat(32) };
    expect(parseWindowsPublicationState(JSON.stringify(value))).toEqual(value);
    for (const change of [{ nonce: status === 'none' ? 'a'.repeat(32) : null }, { status: 'complete' }, { extra: true }]) {
      expect(() => parseWindowsPublicationState(JSON.stringify({ ...value, ...change }))).toThrow();
    }
  }
  const value = { protocol: 'devryan.windows-namespace-durability/1', volume: 'a'.repeat(16), fileId: 'b'.repeat(32),
    directoryFlushed: false, windowsError: 5, publicationQualified: false };
  expect(parseWindowsNamespaceDurability(JSON.stringify(value))).toEqual(value);
  expect(parseWindowsNamespaceDurability(JSON.stringify({ ...value, directoryFlushed: true, windowsError: 0 })).publicationQualified).toBe(false);
  for (const change of [{ publicationQualified: true }, { directoryFlushed: true }, { windowsError: 0 }, { windowsError: -1 }, { windowsError: 1.5 }]) {
    expect(() => parseWindowsNamespaceDurability(JSON.stringify({ ...value, ...change }))).toThrow();
  }
});

test('private deletion settlement binds old identity, nonce, parent and durable absence', () => {
  const value = { protocol: 'devryan.windows-private-deletion/1', status: 'deleted', nonce: 'a'.repeat(32),
    parentVolume: 'b'.repeat(16), parentFileId: 'c'.repeat(32), oldToken: `${'b'.repeat(16)}:${'d'.repeat(32)}:${'e'.repeat(64)}:4`, namespaceFlushed: true };
  expect(parseWindowsPrivateDeletion(JSON.stringify(value))).toEqual(value);
  expect(parseWindowsPrivateDeletion(JSON.stringify({ ...value, oldToken: null })).oldToken).toBeNull();
  for (const change of [{ status: 'pending' }, { nonce: 'bad' }, { extra: true }, { namespaceFlushed: false }, { oldToken: 'absent' },
    { oldToken: `${'f'.repeat(16)}:${'d'.repeat(32)}:${'e'.repeat(64)}:4` },
    { oldToken: `${'b'.repeat(16)}:${'d'.repeat(32)}:${'e'.repeat(64)}:${16 * 1024 * 1024 + 1}` },
    { oldToken: `${'b'.repeat(16)}:${'d'.repeat(32)}:${'e'.repeat(64)}:04` }]) {
    expect(() => parseWindowsPrivateDeletion(JSON.stringify({ ...value, ...change }))).toThrow('private_windows_file_unverified');
  }
});

test('publication CAS uses native identity and exact binary bytes; absence stays distinct', () => {
  const identity = { protocol: 'devryan.windows-file-identity/1', volume: 'a'.repeat(16), fileId: 'b'.repeat(32),
    type: 'file', reparsePoint: false, linkCount: 1, currentOwner: true, privateAcl: true };
  expect(windowsPublicationExpected(null)).toBe('absent');
  expect(windowsPublicationExpected({ identity, bytes: Buffer.alloc(0) })).toBe(`${identity.volume}:${identity.fileId}:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855:0`);
  expect(windowsPublicationExpected({ identity, bytes: Buffer.from([0, 255]) })).not.toBe(windowsPublicationExpected({ identity, bytes: Buffer.from([255, 0]) }));
  for (const changed of [{ linkCount: 2 }, { privateAcl: false }, { currentOwner: false }, { type: 'directory' }, { reparsePoint: true }]) {
    expect(() => windowsPublicationExpected({ identity: { ...identity, ...changed }, bytes: Buffer.alloc(0) })).toThrow();
  }
  expect(() => windowsPublicationExpected({ identity, bytes: 'text' })).toThrow();
});

test('Windows private reads bind binary bytes to a strict private file identity', () => {
  const identity = { protocol: 'devryan.windows-file-identity/1', volume: '0123456789abcdef',
    fileId: '0123456789abcdef0123456789abcdef', type: 'file', reparsePoint: false,
    linkCount: 1, currentOwner: true, privateAcl: true };
  const bytes = Buffer.from([0, 10, 13, 255]);
  const framed = value => Buffer.concat([Buffer.from(JSON.stringify(value) + '\r\n'), bytes]);
  expect(parseWindowsPrivateFileRead(framed(identity))).toEqual({ identity, bytes });
  for (const changed of [{ type: 'directory' }, { reparsePoint: true }, { linkCount: 2 }, { privateAcl: false }, { currentOwner: false }]) {
    expect(() => parseWindowsPrivateFileRead(framed({ ...identity, ...changed }))).toThrow('private_windows_file_unverified');
  }
  expect(() => parseWindowsPrivateFileRead(Buffer.from('{}'))).toThrow('private_windows_file_unverified');
  expect(() => parseWindowsPrivateFileRead('unframed')).toThrow('private_windows_file_unverified');
});
