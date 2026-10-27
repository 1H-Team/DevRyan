import { describe, expect, it } from 'vitest';
import { requiredCheckCommandIssue } from './required-check-command.js';

describe('required check command exit proof', () => {
  it.each([
    'npm test', 'false', 'npm test && echo done', 'cd "directory with spaces" && npm test',
    'bun test "test;literal|name.test.js"', "bun test 'literal$(name).test.js'", 'bun test test\\;literal.test.js',
    'TEST_MODE=unit npm test', 'npm run test -- "a && b"', 'bun test "literal\\$name.test.js"',
  ])('accepts simple argv and failure-preserving conjunction: %s', command => {
    expect(requiredCheckCommandIssue(command)).toBeNull();
  });
  it.each([
    '', ' ', 'npm test; echo done', 'false; echo done', 'npm test\necho done', 'npm test\r\necho done',
    'npm test || echo done', 'npm test | cat', 'npm test &', 'npm test & echo done',
    'echo $(npm test)', 'echo `npm test`', 'npm test > /tmp/result', '(npm test)', '! npm test',
    'sh -c "false; echo done"', '/bin/bash -lc "npm test"', 'env sh -c "npm test"',
    'cmd.exe /c "exit /b 1 & echo done"', 'PowerShell -Command "exit 0"', 'pwsh -File check.ps1',
    'command zsh -c "npm test"', 'eval "false; echo done"', 'source check.sh', '. check.sh',
    'trap "exit 0" EXIT && false', 'builtin eval "false; echo done"', "env -S 'bash -c false;echo done'", 'coproc npm test',
    'npm test # && false', 'npm test &&', '&& npm test', 'npm test && && echo done',
    'bun test "unterminated', 'bun test trailing\\', 'echo "$STATUS"', 'npm test\\\necho done',
  ])('withholds positive proof for ambiguous shell semantics: %s', command => {
    expect(requiredCheckCommandIssue(command)).toBe('required_check_command_exit_ambiguous');
  });
});
