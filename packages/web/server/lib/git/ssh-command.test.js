import { afterEach, describe, expect, it, vi } from 'vitest';

import { sshCommandKeyPath } from './ssh-command.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('sshCommandKeyPath', () => {
  it.each([
    ['ssh -i /keys/id_ed25519', '/keys/id_ed25519'],
    ["ssh -i '/keys/ssh keys/id_ed25519' -o IdentitiesOnly=yes", '/keys/ssh keys/id_ed25519'],
    ['ssh -i /keys/id_ed25519 -o IdentitiesOnly=yes', '/keys/id_ed25519'],
    ['ssh -o IdentitiesOnly=yes -i /keys/id_ed25519', '/keys/id_ed25519'],
    ["ssh -o 'IdentitiesOnly yes' -i /keys/id_ed25519", '/keys/id_ed25519'],
    ['ssh -o identitiesonly=YES -i /keys/id_ed25519', '/keys/id_ed25519'],
    ['ssh -i "/keys/ssh keys/id_ed25519"', '/keys/ssh keys/id_ed25519'],
    ['ssh -i /keys/ssh\\ keys/id_ed25519', '/keys/ssh keys/id_ed25519'],
    ['ssh -i "/keys/\\"quoted\\"/\\id_ed25519"', '/keys/"quoted"/\\id_ed25519'],
    ["ssh -i /keys/'ssh keys'/id_ed25519", '/keys/ssh keys/id_ed25519'],
    ['\tssh  -i  /keys/id_ed25519 ', '/keys/id_ed25519'],
    // Exact even where escapeSshKeyPath will refuse it.
    ["ssh -i '/keys/old (2019)/id_rsa'", '/keys/old (2019)/id_rsa'],
  ])('reads the key path of %j', (sshCommand, keyPath) => {
    expect(sshCommandKeyPath(sshCommand)).toBe(keyPath);
  });

  it.skipIf(process.platform === 'win32').each([
    'ssh -i ~/.ssh/id_ed25519',
    // ssh expands a quoted ~/ itself.
    "ssh -i '~/.ssh/id_ed25519' -o IdentitiesOnly=yes",
  ])('expands the home-relative key path of %j under HOME', (sshCommand) => {
    vi.stubEnv('HOME', '/home/tester');

    expect(sshCommandKeyPath(sshCommand)).toBe('/home/tester/.ssh/id_ed25519');
  });

  it.each([
    [null],
    [''],
    ['ssh'],
    ['ssh -o IdentitiesOnly=yes'],
    ['ssh -i'],
    ["ssh -i ''"],
    ['ssh -i/keys/id_ed25519'],
    ['ssh -i /keys/a -i /keys/b'],
    ['ssh -i /keys/id_ed25519 -p 2222'],
    ['ssh -i /keys/id_ed25519 -o IdentitiesOnly=no'],
    ['ssh -i /keys/id_ed25519 -o StrictHostKeyChecking=accept-new'],
    ['ssh -F /dev/null -i /keys/id_ed25519'],
    ['/usr/bin/ssh -i /keys/id_ed25519'],
    ['GIT_TRACE=1 ssh -i /keys/id_ed25519'],
    ['ssh -i $HOME/.ssh/id_ed25519'],
    ['ssh -i "${HOME}/.ssh/id_ed25519"'],
    ['ssh -i "`cat /keys/name`"'],
    ['ssh -i /keys/id_ed25519; true'],
    ['ssh -i /keys/id_ed25519 && true'],
    ['ssh -i /keys/id_ed25519 | true'],
    ['ssh -i /keys/id_ed25519 > /dev/null'],
    ['ssh -i /keys/id_*'],
    ['ssh -i /keys/id_?25519'],
    ['ssh -i /keys/{a,b}'],
    ['ssh -i /keys/id_ed25519 # comment'],
    ['ssh -i ~other/.ssh/id_ed25519'],
    ['ssh -i ~'],
    ["ssh -i '/keys/id_ed25519"],
    ['ssh -i "/keys/id_ed25519'],
    ['ssh -i /keys/id_ed25519\\'],
    ['ssh -i /keys/id_ed25519\nssh -i /keys/other'],
  ])('reads no key path from %j', (sshCommand) => {
    expect(sshCommandKeyPath(sshCommand)).toBeNull();
  });
});
