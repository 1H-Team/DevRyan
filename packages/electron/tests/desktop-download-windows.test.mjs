import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { downloadWindowsOwnedUpdate } from '../desktop-download-windows.mjs';

const failure = code => Object.assign(new Error(code), { code });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const payload = Buffer.from([0, 255, 128, 13, 10, 0, 50, 200]);
const cacheDirectory = 'C:\\Updates';
function fixture() {
  const files = new Map(), records = new Map(), requests = [], events = [];
  let revision = 0, opened = 0, finished = 0;
  const update = { version: '2.0.3', name: 'DevRyan-2.0.3-win-x64.exe', url: 'https://github.com/1H-Team/DevRyan/releases/download/v2.0.3/DevRyan-2.0.3-win-x64.exe', size: payload.length, sha256: hash(payload) };
  const file = `${cacheDirectory}\\${update.version}\\${update.name}`, identityPath = `${cacheDirectory}\\${update.version}\\download-identity.json`;
  const receipt = bytes => ({ protocol: 'devryan.windows-update-file/1', size: bytes.length, token: `${'1'.repeat(16)}:${'2'.repeat(32)}:${hash(bytes)}:${bytes.length}` });
  const owner = {
    ensureDirectory: async () => {},
    file: async name => { if (!files.has(name)) throw failure('ENOENT'); return receipt(files.get(name)); },
    read: async name => { if (!records.has(name)) throw failure('ENOENT'); return records.get(name); },
    write: async (name, bytes, { expected }) => { if ((records.get(name)?.revision ?? null) !== (expected?.revision ?? null)) throw failure('private_file_changed'); const record = { bytes: Buffer.from(bytes), revision: ++revision }; records.set(name, record); return record; },
    beginDownload: async (name, { offset, size, expected }) => {
      const current = files.get(name);
      if ((current ? receipt(current).token : 'absent') !== expected || offset && offset !== current?.length) throw failure('update_download_compare_and_swap');
      opened++; files.set(name, offset ? Buffer.from(current) : Buffer.alloc(0));
      return { write: async bytes => { const next = Buffer.concat([files.get(name), bytes]); if (next.length > size) throw failure('update_download_response_bound'); files.set(name, next); },
        finish: async () => { finished++; return receipt(files.get(name)); } };
    },
  };
  const fetchImpl = async (url, options) => { requests.push({ url, options }); return new Response(payload, { status: 200, headers: { 'content-length': String(payload.length) } }); };
  const args = { owner, cacheDirectory, update, fetchImpl, controller: new AbortController(), emit: (event, data) => events.push({ event, data }), idleTimeoutMs: 1000 };
  const partial = bytes => { files.set(file, Buffer.from(bytes)); records.set(identityPath, { bytes: Buffer.from(JSON.stringify({ url: update.url, size: update.size, sha256: update.sha256 })), revision: ++revision }); };
  return { args, owner, update, file, files, records, requests, events, partial, opened: () => opened, finished: () => finished };
}
test('owned Windows binary download verifies release digest and preserves all bytes', async () => {
  const f = fixture(); assert.equal(await downloadWindowsOwnedUpdate(f.args), f.file); assert.deepEqual(f.files.get(f.file), payload);
  assert.equal(f.opened(), 1); assert.equal(f.finished(), 1); assert.equal(f.events.at(-1).event, 'Finished'); assert.equal(f.requests[0].options.headers['Accept-Encoding'], 'identity');
});
test('matching complete owner receipt avoids both network and a writable handle', async () => {
  const f = fixture(); f.files.set(f.file, payload); f.args.fetchImpl = async () => assert.fail('already verified file must not fetch');
  assert.equal(await downloadWindowsOwnedUpdate(f.args), f.file); assert.equal(f.opened(), 0);
});
test('partial identity resumes exact range through the native owner CAS', async () => {
  const f = fixture(); f.partial(payload.subarray(0, 3));
  f.args.fetchImpl = async (_url, options) => { assert.equal(options.headers.Range, 'bytes=3-'); return new Response(payload.subarray(3), { status: 206, headers: { 'content-range': `bytes 3-${payload.length - 1}/${payload.length}`, 'content-length': String(payload.length - 3) } }); };
  assert.equal(await downloadWindowsOwnedUpdate(f.args), f.file); assert.deepEqual(f.files.get(f.file), payload);
});
test('server 200 after a resume request truncates through the owner and restarts', async () => {
  const f = fixture(); f.partial(payload.subarray(0, 3)); const fetch = f.args.fetchImpl;
  f.args.fetchImpl = async (url, options) => { assert.equal(options.headers.Range, 'bytes=3-'); return fetch(url, options); };
  await downloadWindowsOwnedUpdate(f.args); assert.deepEqual(f.files.get(f.file), payload);
});
test('interrupted binary response settles the writer and next attempt resumes exact durable bytes', async () => {
  const f = fixture();
  let reads = 0;
  f.args.fetchImpl = async () => new Response(new ReadableStream({ pull(controller) { if (reads++ === 0) controller.enqueue(payload.subarray(0, 3)); else controller.error(failure('network_interrupted')); } }), { status: 200 });
  await assert.rejects(downloadWindowsOwnedUpdate(f.args), { code: 'network_interrupted' }); assert.equal(f.finished(), 1); assert.deepEqual(f.files.get(f.file), payload.subarray(0, 3));
  f.args.controller = new AbortController();
  f.args.fetchImpl = async (_url, options) => { assert.equal(options.headers.Range, 'bytes=3-'); return new Response(payload.subarray(3), { status: 206, headers: { 'content-range': `bytes 3-${payload.length - 1}/${payload.length}` } }); };
  await downloadWindowsOwnedUpdate(f.args); assert.deepEqual(f.files.get(f.file), payload);
});
for (const headers of [{ 'content-range': 'bytes 2-7/8' }, { 'content-range': 'bytes 3-7/8', 'content-length': '99' }]) test('unverified resume framing refuses before native writable admission', async () => {
  const f = fixture(); f.partial(payload.subarray(0, 3)); f.args.fetchImpl = async () => new Response(payload.subarray(3), { status: 206, headers });
  await assert.rejects(downloadWindowsOwnedUpdate(f.args), { code: headers['content-length'] ? 'update_integrity_failed' : 'update_resume_invalid' }); assert.equal(f.opened(), 0);
});
test('same-size digest mismatch never publishes Finished', async () => {
  const f = fixture(); f.args.fetchImpl = async () => new Response(Buffer.alloc(payload.length), { status: 200 });
  await assert.rejects(downloadWindowsOwnedUpdate(f.args), { code: 'update_integrity_failed' }); assert.equal(f.events.some(event => event.event === 'Finished'), false); assert.equal(f.finished(), 1);
});
test('response byte bound refuses oversized chunks and settles partial writer', async () => {
  const f = fixture(); f.args.fetchImpl = async () => new Response(Buffer.alloc(payload.length + 1), { status: 200 });
  await assert.rejects(downloadWindowsOwnedUpdate(f.args), { code: 'update_integrity_failed' }); assert.equal(f.finished(), 1); assert.equal(f.files.get(f.file).length, 0);
});
test('owner detects file replacement between metadata and writer acquisition', async () => {
  const f = fixture(); f.partial(payload.subarray(0, 3));
  f.args.fetchImpl = async () => { f.files.set(f.file, Buffer.from([4, 5, 6])); return new Response(payload, { status: 200 }); };
  await assert.rejects(downloadWindowsOwnedUpdate(f.args), { code: 'update_download_compare_and_swap' }); assert.equal(f.opened(), 0); assert.deepEqual(f.files.get(f.file), Buffer.from([4, 5, 6]));
});
test('without a native private owner Windows download never starts a request', async () => {
  const f = fixture(); f.args.owner = undefined; f.args.fetchImpl = async () => assert.fail('unowned download must not fetch');
  await assert.rejects(downloadWindowsOwnedUpdate(f.args), { code: 'update_native_owner_unavailable' });
});
