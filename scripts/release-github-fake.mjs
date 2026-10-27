// Stateful in-memory GitHub for the release scripts: releases, assets,
// uploads, git refs and annotated tags, CI and release workflow runs, and the
// public download host, behind a `fetchImpl`. Response shapes follow the real
// API (scripts/fixtures/github-api): drafts have untagged-* page and download
// URLs and are invisible to anonymous requests.
//
// Used by the release tests (crash-point convergence) and by
// `release.mjs stage|publish|release --simulate`. It never calls the network:
// any host other than api.github.com, uploads.github.com and github.com fails.
//
// Faults: `fault(index, mode)` arms request number `index` (0-based, every
// request counts): 'before' fails the connection without effect, 'lost'
// applies the effect and then loses the response, '502' answers 502 without
// effect.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { RELEASE_REPOSITORY } from '../packages/electron/release-assets.mjs';

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

export function createFakeGitHub({ repository = RELEASE_REPOSITORY, tags = {}, ciRuns = [], releaseRuns = [], blobDirectory, state: restored,
  digestLagMs = 0, now = Date.now } = {}) {
  const state = restored ?? {
    repository, nextId: 1000, tick: 0, releases: [], latestId: null,
    refs: Object.fromEntries(Object.entries(tags).map(([name, sha]) => [`tags/${name}`, { type: 'commit', sha }])),
    tagObjects: {}, ciRuns, releaseRuns, violations: [], effects: [],
  };
  const requests = [];
  let armed = null;
  const stamp = () => new Date(Date.UTC(2026, 9, 23, 6, 0, 0) + 1000 * state.tick++).toISOString().replace('.000Z', 'Z');
  const api = `https://api.github.com/repos/${state.repository}`;
  const pageBase = `https://github.com/${state.repository}/releases`;
  const json = (status, body, headers = {}) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const untagged = release => `untagged-${crypto.createHash('sha1').update(String(release.id)).digest('hex').slice(0, 20)}`;
  const tagSegment = release => release.draft ? untagged(release) : release.tag_name;
  const assetView = (release, asset) => ({ url: `${api}/releases/assets/${asset.id}`, id: asset.id, name: asset.name, label: '', content_type: 'application/octet-stream',
    state: asset.state, size: asset.size, digest: (asset.digestAt ?? 0) <= now() ? asset.digest : null, download_count: 0, created_at: asset.created_at, updated_at: asset.updated_at,
    browser_download_url: `${pageBase}/download/${tagSegment(release)}/${asset.name}` });
  const releaseView = release => ({ url: `${api}/releases/${release.id}`, assets_url: `${api}/releases/${release.id}/assets`,
    upload_url: `https://uploads.github.com/repos/${state.repository}/releases/${release.id}/assets{?name,label}`,
    html_url: `${pageBase}/tag/${tagSegment(release)}`, id: release.id, tag_name: release.tag_name, target_commitish: release.target_commitish,
    name: release.name, draft: release.draft, immutable: false, prerelease: release.prerelease, created_at: release.created_at, updated_at: release.updated_at,
    published_at: release.published_at, assets: release.assets.map(asset => assetView(release, asset)), body: release.body });
  const find = id => state.releases.find(row => row.id === Number(id));
  const effect = (name) => state.effects.push(name);
  const storeBlob = (id, bytes) => {
    if (!blobDirectory) return { inline: bytes.toString('base64') };
    const file = path.join(blobDirectory, `asset-${id}`);
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    return { file };
  };
  const readBlob = blob => blob.file ? fs.createReadStream(blob.file) : Readable.from([Buffer.from(blob.inline, 'base64')]);

  async function handle(url, { method = 'GET', headers = {}, body } = {}) {
    const { hostname, pathname, searchParams } = new URL(url);
    const authorized = Boolean(headers.Authorization ?? headers.authorization);
    if (hostname === 'github.com') {
      const match = new RegExp(`^/${state.repository}/releases/download/([^/]+)/([^/]+)$`).exec(pathname);
      const release = match && state.releases.find(row => !row.draft && row.tag_name === decodeURIComponent(match[1]));
      const asset = release?.assets.find(row => row.name === decodeURIComponent(match[2]) && row.state === 'uploaded');
      if (!asset) return new Response('Not Found', { status: 404 });
      const range = /^bytes=(\d+)-$/.exec(headers.Range ?? '');
      if (range) {
        const start = Number(range[1]);
        const stream = asset.blob.file ? fs.createReadStream(asset.blob.file, { start }) : Readable.from([Buffer.from(asset.blob.inline, 'base64').subarray(start)]);
        return new Response(Readable.toWeb(stream), { status: 206, headers: { 'content-range': `bytes ${start}-${asset.size - 1}/${asset.size}` } });
      }
      return new Response(Readable.toWeb(readBlob(asset.blob)), { status: 200, headers: { 'content-length': String(asset.size) } });
    }
    if (!['api.github.com', 'uploads.github.com'].includes(hostname)) throw new TypeError(`The fake GitHub does not serve ${hostname}`);
    const prefix = `/repos/${state.repository}`;
    if (!pathname.startsWith(prefix)) return json(404, { message: 'Not Found' });
    const route = pathname.slice(prefix.length);
    const page = Number(searchParams.get('page') ?? '1');
    const perPage = Number(searchParams.get('per_page') ?? '30');
    const paged = rows => rows.slice((page - 1) * perPage, page * perPage);
    const visible = release => authorized || !release.draft;
    const read = async () => { const chunks = []; for await (const chunk of body) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks); };
    let match;

    if (hostname === 'uploads.github.com') {
      if (method !== 'POST' || !(match = /^\/releases\/(\d+)\/assets$/.exec(route))) return json(404, { message: 'Not Found' });
      const release = find(match[1]);
      if (!release) return json(404, { message: 'Not Found' });
      const name = searchParams.get('name');
      if (release.assets.some(row => row.name === name)) return json(422, { message: 'Validation Failed', errors: [{ resource: 'ReleaseAsset', code: 'already_exists', field: 'name' }] });
      const bytes = await read();
      const id = state.nextId++, at = stamp();
      const asset = { id, name, size: bytes.length, state: 'uploaded', digest: `sha256:${sha256(bytes)}`, digestAt: now() + digestLagMs, created_at: at, updated_at: at, blob: storeBlob(id, bytes) };
      release.assets.push(asset);
      effect(`upload ${name}`);
      return json(201, assetView(release, asset));
    }
    if (method === 'GET' && route === '/releases') return json(200, paged([...state.releases].reverse().filter(visible).map(releaseView)));
    if (method === 'POST' && route === '/releases') {
      const fields = JSON.parse(body);
      const at = stamp();
      const release = { id: state.nextId++, tag_name: fields.tag_name, target_commitish: fields.target_commitish, name: fields.name, body: fields.body,
        draft: fields.draft === true, prerelease: fields.prerelease === true, created_at: at, updated_at: at, published_at: fields.draft ? null : at, assets: [] };
      state.releases.push(release);
      if (!release.draft) state.latestId = release.id;
      effect(`create release ${release.tag_name}`);
      return json(201, releaseView(release));
    }
    if (method === 'GET' && route === '/releases/latest') {
      const latest = find(state.latestId);
      return latest && !latest.draft ? json(200, releaseView(latest)) : json(404, { message: 'Not Found' });
    }
    if (method === 'GET' && (match = /^\/releases\/tags\/(.+)$/.exec(route))) {
      const release = state.releases.find(row => !row.draft && row.tag_name === decodeURIComponent(match[1]));
      return release ? json(200, releaseView(release)) : json(404, { message: 'Not Found' });
    }
    if ((match = /^\/releases\/(\d+)$/.exec(route))) {
      const release = find(match[1]);
      if (!release || !visible(release)) return json(404, { message: 'Not Found' });
      if (method === 'GET') return json(200, releaseView(release));
      if (method === 'PATCH') {
        const fields = JSON.parse(body);
        for (const key of ['tag_name', 'target_commitish', 'name', 'body', 'prerelease']) if (key in fields) release[key] = fields[key];
        if (fields.draft === false && release.draft) {
          if (!release.assets.some(asset => asset.state === 'uploaded')) state.violations.push(`release ${release.id} published with zero assets`);
          release.draft = false;
          release.published_at = stamp();
          effect(`publish release ${release.tag_name}`);
        } else if (fields.draft === true) release.draft = true;
        if (fields.make_latest === 'true' && !release.draft) state.latestId = release.id;
        release.updated_at = stamp();
        return json(200, releaseView(release));
      }
      if (method === 'DELETE') {
        state.releases.splice(state.releases.indexOf(release), 1);
        effect(`delete release ${release.id}`);
        return new Response(null, { status: 204 });
      }
    }
    if (method === 'GET' && (match = /^\/releases\/(\d+)\/assets$/.exec(route))) {
      const release = find(match[1]);
      return release && visible(release) ? json(200, paged(release.assets.map(asset => assetView(release, asset)))) : json(404, { message: 'Not Found' });
    }
    if (method === 'DELETE' && (match = /^\/releases\/assets\/(\d+)$/.exec(route))) {
      for (const release of state.releases) {
        const asset = release.assets.find(row => row.id === Number(match[1]));
        if (!asset) continue;
        if (!release.draft) state.violations.push(`asset ${asset.id} deleted from published release ${release.id}`);
        release.assets.splice(release.assets.indexOf(asset), 1);
        effect(`delete asset ${asset.id}`);
        return new Response(null, { status: 204 });
      }
      return json(404, { message: 'Not Found' });
    }
    if (method === 'GET' && (match = /^\/git\/ref\/(tags\/.+)$/.exec(route))) {
      const ref = state.refs[decodeURIComponent(match[1])];
      return ref ? json(200, { ref: `refs/${match[1]}`, object: ref }) : json(404, { message: 'Not Found' });
    }
    if (method === 'GET' && (match = /^\/git\/tags\/([a-f0-9]{40})$/.exec(route))) {
      const tag = state.tagObjects[match[1]];
      return tag ? json(200, tag) : json(404, { message: 'Not Found' });
    }
    if (method === 'POST' && route === '/git/tags') {
      const { tag, message, object, type } = JSON.parse(body);
      const sha = crypto.createHash('sha1').update(`${tag}\n${message}\n${object}\n${state.nextId++}`).digest('hex');
      state.tagObjects[sha] = { sha, tag, message, object: { type, sha: object } };
      return json(201, { sha, tag });
    }
    if (method === 'POST' && route === '/git/refs') {
      const { ref, sha } = JSON.parse(body);
      const key = ref.slice('refs/'.length);
      if (state.refs[key]) return json(422, { message: 'Reference already exists' });
      state.refs[key] = { type: state.tagObjects[sha] ? 'tag' : 'commit', sha };
      effect(`create ref ${key}`);
      return json(201, { ref, object: state.refs[key] });
    }
    if (method === 'GET' && route === '/actions/workflows/ci.yml/runs') {
      return json(200, { workflow_runs: page > 1 ? [] : state.ciRuns.filter(run => !searchParams.get('head_sha') || run.head_sha === searchParams.get('head_sha')) });
    }
    if (method === 'GET' && route === '/actions/workflows/release.yml/runs') {
      return json(200, { workflow_runs: page > 1 ? [] : state.releaseRuns.filter(run => !searchParams.get('head_sha') || run.head_sha === searchParams.get('head_sha')) });
    }
    if (method === 'GET' && (match = /^\/actions\/runs\/(\d+)\/(artifacts|jobs)$/.exec(route))) {
      const run = state.releaseRuns.find(row => row.id === Number(match[1]));
      return json(200, match[2] === 'artifacts' ? { artifacts: page > 1 ? [] : run?.artifacts ?? [] } : { jobs: page > 1 ? [] : run?.jobs ?? [] });
    }
    return json(500, { message: `The fake GitHub does not implement ${method} ${route}` });
  }

  const fetchImpl = async (url, init = {}) => {
    const index = requests.length;
    const method = init.method ?? 'GET';
    requests.push({ index, method, url: String(url) });
    if (armed?.index === index) {
      const { mode } = armed;
      armed = null;
      if (mode === 'before') await init.body?.cancel?.().catch(() => {});
      if (mode === 'before') throw new TypeError('fetch failed', { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
      if (mode === '502') { await init.body?.cancel?.().catch(() => {}); return json(502, { message: 'Bad Gateway' }); }
      if (mode === 'lost') {
        const response = await handle(url, init);
        await response.body?.cancel().catch(() => {});
        throw new TypeError('fetch failed', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) });
      }
      if (mode === 'body') {
        const response = await handle(url, init);
        await response.body?.cancel().catch(() => {});
        if (response.status === 204) return response;
        return new Response(new ReadableStream({ start(controller) {
          controller.error(new TypeError('terminated', { cause: { code: 'UND_ERR_SOCKET' } }));
        } }), { status: response.status, headers: response.headers });
      }
    }
    return handle(url, init);
  };

  return {
    state, fetchImpl, requests,
    fault(index, mode) { armed = { index, mode }; },
    /** Serializable state for a later process (`--simulate` split runs). */
    serialize: () => JSON.stringify(state),
    publicReleases: () => state.releases.filter(row => !row.draft),
    ledgerRefs: () => Object.keys(state.refs).filter(key => key.startsWith('tags/devryan-release/')),
  };
}

export function restoreFakeGitHub(serialized, options = {}) {
  return createFakeGitHub({ ...options, state: JSON.parse(serialized) });
}
