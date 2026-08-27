import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  parseAuthPasswordPolicy,
  syncSupabaseAuthPasswordPolicy,
} from './sync-supabase-auth-password-policy.mjs';

const policy = {
  minimumPasswordLength: 6,
  passwordRequiredCharacters: '',
};

const response = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

describe('Supabase Auth password policy sync', () => {
  it('reads the focused password policy from the auth section', () => {
    assert.deepEqual(parseAuthPasswordPolicy(`
[api]
port = 54321

[auth]
minimum_password_length = 6
password_requirements = ""

[auth.email]
enable_signup = true
`), policy);
  });

  it('rejects unsupported composition requirements instead of guessing their API encoding', () => {
    assert.throws(() => parseAuthPasswordPolicy(`
[auth]
minimum_password_length = 6
password_requirements = "letters_digits"
`), /Only an empty auth\.password_requirements value is supported/);
  });

  it('rejects a password length below the hosted Management API floor', () => {
    assert.throws(() => parseAuthPasswordPolicy(`
[auth]
minimum_password_length = 4
password_requirements = ""
`), /auth\.minimum_password_length must be at least 6/);
  });

  it('does not patch when the hosted policy already matches', async () => {
    const requests = [];
    const fetchImpl = async (url, init) => {
      requests.push({ url, init });
      return response({ password_min_length: 6, password_required_characters: '' });
    };

    const result = await syncSupabaseAuthPasswordPolicy({
      accessToken: 'test-token', projectId: 'test-project', policy, fetchImpl,
    });

    assert.deepEqual(result, { changed: false, policy });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].init.method, 'GET');
  });

  it('patches only the password fields and verifies the result', async () => {
    const requests = [];
    const responses = [
      { password_min_length: 12, password_required_characters: '' },
      { password_min_length: 6, password_required_characters: '' },
      { password_min_length: 6, password_required_characters: '' },
    ];
    const fetchImpl = async (url, init) => {
      requests.push({ url, init });
      return response(responses.shift());
    };

    const result = await syncSupabaseAuthPasswordPolicy({
      accessToken: 'test-token', projectId: 'project/ref', policy, fetchImpl,
    });

    assert.deepEqual(result, { changed: true, policy });
    assert.deepEqual(requests.map(({ init }) => init.method), ['GET', 'PATCH', 'GET']);
    assert.equal(requests[0].url, 'https://api.supabase.com/v1/projects/project%2Fref/config/auth');
    assert.deepEqual(JSON.parse(requests[1].init.body), {
      password_min_length: 6,
      password_required_characters: '',
    });
    assert.equal(requests[1].init.headers.Authorization, 'Bearer test-token');
  });

  it('fails without exposing a response body when the Management API rejects the request', async () => {
    const fetchImpl = async () => response({ access_token: 'must-not-appear' }, 403);

    await assert.rejects(
      syncSupabaseAuthPasswordPolicy({
        accessToken: 'test-token', projectId: 'test-project', policy, fetchImpl,
      }),
      (error) => error.message === 'Supabase Auth configuration GET failed with HTTP 403'
        && !error.message.includes('must-not-appear'),
    );
  });

  it('fails when the post-update read does not match', async () => {
    const responses = [
      { password_min_length: 12, password_required_characters: '' },
      { password_min_length: 12, password_required_characters: '' },
      { password_min_length: 12, password_required_characters: '' },
    ];

    await assert.rejects(
      syncSupabaseAuthPasswordPolicy({
        accessToken: 'test-token',
        projectId: 'test-project',
        policy,
        fetchImpl: async () => response(responses.shift()),
      }),
      /verification failed after update/,
    );
  });
});
