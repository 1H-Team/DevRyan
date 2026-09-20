import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { isDirectLocalRequest } from '../security/direct-local-request.js';

const filename = 'local-owner-bootstrap.json';
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const validOrigin = (value) => {
  try { const url = new URL(value); return url.origin === value && url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname); }
  catch { return false; }
};

// Explicit filesystem-owner action. The web server cannot create this proof.
export async function prepareLocalOwnerEnrollment({ dataDirectory, origin, allowEnrollment = true, now = Date.now }) {
  if (!validOrigin(origin)) throw new Error('Owner enrollment requires a loopback HTTP origin');
  const stat = await fs.stat(dataDirectory);
  if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o022)) {
    throw new Error('Owner enrollment requires a private directory owned by the current user');
  }
  const token = crypto.randomBytes(32).toString('base64url');
  const target = path.join(dataDirectory, filename);
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify({ version: 1, tokenHash: hash(token), origin, allowEnrollment, expiresAt: now() + 120_000 }), { flag: 'wx', mode: 0o600 });
  await fs.rename(temporary, target);
  return { url: `${origin}/auth/local-owner-bootstrap#t=${token}`, expiresInSeconds: 120 };
}

export function registerLocalOwnerBootstrap(app, { dataDirectory, connection, now = Date.now }) {
  app.get('/auth/local-owner-bootstrap', (req, res) => {
    if (!isDirectLocalRequest(req)) return res.sendStatus(403);
    const nonce = crypto.randomBytes(16).toString('base64');
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`);
    return res.type('html').send(`<!doctype html><html lang="en"><meta charset="utf-8"><title>DevRyan local owner</title><h1>Enroll this browser as the local owner</h1><button id="enroll">Enroll</button><p role="status" id="status"></p><script nonce="${nonce}">let token=new URLSearchParams(location.hash.slice(1)).get('t');history.replaceState(null,'',location.pathname);document.getElementById('enroll').onclick=async()=>{const response=await fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json','X-DevRyan-CSRF':'1'},body:JSON.stringify({token})});if(response.ok){token=null;location.replace('/');}else document.getElementById('status').textContent='Enrollment failed. Run enroll-owner again on this host.';};</script></html>`);
  });
  app.post('/auth/local-owner-bootstrap', express.json({ limit: '2kb' }), async (req, res) => {
    if (!isDirectLocalRequest(req) || req.headers['x-devryan-csrf'] !== '1' || !validOrigin(req.headers.origin)
      || typeof req.body?.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(req.body.token)) return res.sendStatus(403);
    const target = path.join(dataDirectory, filename);
    let consumed = null;
    try {
      const record = JSON.parse(await fs.readFile(target, 'utf8'));
      if (record.version !== 1 || record.origin !== req.headers.origin || record.expiresAt <= now()
        || record.tokenHash !== hash(req.body.token)) return res.sendStatus(403);
      consumed = `${target}.${crypto.randomUUID()}.consumed`;
      await fs.rename(target, consumed);
      // Compare again after the exclusive consume in case the filesystem owner
      // issued a different challenge between the read and the rename.
      const actual = JSON.parse(await fs.readFile(consumed, 'utf8'));
      if (actual.tokenHash !== record.tokenHash) return res.sendStatus(403);
      if (actual.allowEnrollment === false && !connection.ownerPrincipal()) {
        return res.status(403).json({ code: 'local_owner_required', error: 'Run openchamber enroll-owner to enroll this host first' });
      }
      await connection.bootstrapLocalOwner();
      const cookie = await connection.issueLocalOwnerSession();
      if (!cookie) return res.status(409).json({ error: 'A configured host requires its enrolled managed owner' });
      connection.setOwnerCookie(res, cookie);
      return res.status(204).end();
    } catch { return res.sendStatus(403); }
    finally { if (consumed) await fs.rm(consumed, { force: true }).catch(() => {}); }
  });
}
