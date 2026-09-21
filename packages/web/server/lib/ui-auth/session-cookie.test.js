import { expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { requestUiSessionCookieName, uiSessionCookieName } from './session-cookie.js';
import { createRequestSecurityRuntime } from '../security/request-security.js';

test('socket listening port selects the cookie even with forged Host and forwarding headers', () => {
  const runtime = createRequestSecurityRuntime({});
  const request = { socket: { localPort: 3001 }, headers: { host: 'localhost:9999', 'x-forwarded-host': 'localhost:9999',
    cookie: 'oc_ui_session=legacy; oc_ui_session_3001=one; oc_ui_session_3002=two' } };
  expect(requestUiSessionCookieName(request)).toBe('oc_ui_session_3001');
  expect(runtime.getUiSessionTokenFromRequest(request)).toBe('one');
  request.socket.localPort = 3002;
  expect(runtime.getUiSessionTokenFromRequest(request)).toBe('two');
  request.socket.localPort = 3003;
  expect(runtime.getUiSessionTokenFromRequest(request)).toBeNull();
  for (const port of [0, -1, NaN, 65536, '3001']) expect(() => uiSessionCookieName(port)).toThrow('listening port');
});

test('signed sessions bind to their issued port and legacy cookies cannot authenticate', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-port-auth-'));
  try {
    const script = `import assert from 'node:assert/strict';
      import {createUiAuth} from ${JSON.stringify(new URL('./ui-auth.js', import.meta.url).href)};
      const auth = createUiAuth({password:'synthetic-fixture',readSettingsFromDiskMigrated:async()=>({})});
      const response = () => ({headers:{},code:200,setHeader(k,v){this.headers[k]=v;},status(code){this.code=code;return this;},json(body){this.body=body;}});
      const req={headers:{accept:'application/json'},socket:{localPort:3001},ip:'127.0.0.1',body:{password:'synthetic-fixture'}};
      try {
        const login=response();await auth.handleSessionCreate(req,login);
        const cookie=login.headers['Set-Cookie'].split(';')[0];
        assert(cookie.startsWith('oc_ui_session_3001='));
        for (const [port,value,allowed] of [[3001,cookie,true],[3002,cookie,false],[3002,cookie.replace('_3001=','_3002='),false],[3001,cookie.replace('_3001=','='),false]]) {
          const result=response();await auth.handleSessionStatus({...req,socket:{localPort:port},headers:{...req.headers,cookie:value}},result);
          assert.equal(result.body.authenticated,allowed);
        }
      } finally {auth.dispose();}`;
    await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, OPENCHAMBER_DATA_DIR: directory, OPENCODE_JWT_SECRET: undefined }, timeout: 15_000,
    });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
