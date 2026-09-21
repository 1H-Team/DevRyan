import test from 'node:test';
import assert from 'node:assert/strict';
import { uiSessionCookieHeader } from './ui-session-cookie.mjs';

test('requires the actual cookie identity instead of guessing it from a public URL', () => {
  assert.equal(uiSessionCookieHeader('oc_ui_session_42991=fixture'), 'oc_ui_session_42991=fixture');
  for (const invalid of ['fixture', 'oc_ui_session=fixture', 'oc_ui_session_0=fixture', 'oc_ui_session_65536=x', 'oc_ui_session_3000=x; other=y']) {
    assert.throws(() => uiSessionCookieHeader(invalid), /actual|instance/);
  }
});
