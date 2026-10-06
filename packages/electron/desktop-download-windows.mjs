import path from 'node:path';
const fail = code => Object.assign(new Error(code), { code });
export async function downloadWindowsOwnedUpdate({ owner, cacheDirectory, update, fetchImpl, controller, emit, idleTimeoutMs }) {
  if (!owner) throw fail('update_native_owner_unavailable');
  await owner.ensureDirectory(cacheDirectory);
  const directory = path.win32.join(cacheDirectory, update.version); await owner.ensureDirectory(directory);
  const file = path.win32.join(directory, update.name), identityPath = path.win32.join(directory, 'download-identity.json');
  const identity = JSON.stringify({ url: update.url, size: update.size, sha256: update.sha256 });
  const before = await owner.file(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (before?.size === update.size && before.token.split(':')[2] === update.sha256) { emit('Finished', {}); return file; }
  const previous = await owner.read(identityPath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  let offset = previous?.bytes.toString('utf8') === identity && before && before.size < update.size ? before.size : 0;
  await owner.write(identityPath, Buffer.from(identity), { expected: previous });
  let timer, reader, writer;
  const reset = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(fail('update_download_timeout')), idleTimeoutMs); timer.unref?.(); };
  try {
    reset();
    const response = await fetchImpl(update.url, { headers: { ...(offset ? { Range: `bytes=${offset}-` } : {}), 'Accept-Encoding': 'identity' }, signal: controller.signal });
    if (response.status === 200) offset = 0;
    else if (response.status !== 206 || response.headers.get('content-range') !== `bytes ${offset}-${update.size - 1}/${update.size}`) {
      await response.body?.cancel(); throw fail('update_resume_invalid');
    }
    const length = response.headers.get('content-length');
    if (length !== null && Number(length) !== update.size - offset) { await response.body?.cancel(); throw fail('update_integrity_failed'); }
    reader = response.body?.getReader(); if (!reader) throw fail('update_download_incomplete');
    writer = await owner.beginDownload(file, { offset, size: update.size, expected: before?.token ?? 'absent' });
    emit('Started', { contentLength: update.size }); emit('Progress', { downloaded: offset, total: update.size, chunkLength: 0 });
    for (;;) {
      const { value, done } = await reader.read(); if (done) break; reset();
      if (offset + value.length > update.size) throw fail('update_integrity_failed');
      await writer.write(value); offset += value.length;
      emit('Progress', { downloaded: offset, total: update.size, chunkLength: value.length });
    }
    const result = await writer.finish(); writer = null;
    if (offset !== update.size || result.size !== update.size) throw fail('update_download_incomplete');
    if (result.token.split(':')[2] !== update.sha256) throw fail('update_integrity_failed');
    emit('Finished', {}); return file;
  } catch (error) {
    if (writer) await writer.finish();
    emit('Error', { message: error.message }); throw error;
  } finally { clearTimeout(timer); await reader?.cancel().catch(() => {}); }
}
