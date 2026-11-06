// Reads key paths back out of `core.sshCommand` values. Git runs the value with
// the shell, so it is read as a POSIX shell reads it. Only a command that does
// nothing but name a key yields its key path, which buildSshCommand
// (service.js) writes back for a profile.
import os from 'node:os';
import path from 'node:path';

// Unquoted, these make the shell expand, glob, redirect, chain or comment.
const UNQUOTED_SPECIAL = new Set('|&;<>()$`*?[]{}#!');
// Inside double quotes, a backslash escapes only these characters.
const DOUBLE_QUOTED_ESCAPABLE = new Set('$`"\\');
// Every control character but tab; a newline would start another command.
const CONTROL_CHARACTER = /[\u0000-\u0008\u000a-\u001f\u007f]/;
const IDENTITIES_ONLY_YES = /^IdentitiesOnly(?:\s*=\s*|\s+)yes$/i;

// The words the shell passes for `command`, or null when it would do more than
// remove quotes and split words.
const shellWords = (command) => {
  if (CONTROL_CHARACTER.test(command)) return null;
  const words = [];
  let word = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (char === ' ' || char === '\t') {
      if (word !== null) words.push(word);
      word = null;
      continue;
    }
    word ??= '';
    if (char === "'") {
      const end = command.indexOf("'", index + 1);
      if (end === -1) return null;
      word += command.slice(index + 1, end);
      index = end;
    } else if (char === '"') {
      for (index += 1; command[index] !== '"'; index += 1) {
        if (index >= command.length || command[index] === '$' || command[index] === '`') return null;
        if (command[index] === '\\' && DOUBLE_QUOTED_ESCAPABLE.has(command[index + 1])) index += 1;
        word += command[index];
      }
    } else if (char === '\\') {
      index += 1;
      if (index >= command.length) return null;
      word += command[index];
    } else if (UNQUOTED_SPECIAL.has(char)) {
      return null;
    } else {
      word += char;
    }
  }
  if (word !== null) words.push(word);
  return words;
};

/**
 * The key path of `ssh -i <key>`, alone or with `-o IdentitiesOnly=yes`, in
 * any quoting. A `~/` prefix is expanded under HOME, as ssh does; otherwise the
 * path is returned exactly, unvalidated. Any other program, option or shell
 * expansion, or another user's `~`, returns null.
 */
export const sshCommandKeyPath = (sshCommand) => {
  const words = typeof sshCommand === 'string' ? shellWords(sshCommand) : null;
  if (!words || words[0] !== 'ssh') return null;
  let keyPath = null;
  for (let index = 1; index < words.length; index += 2) {
    const option = words[index];
    const value = words[index + 1];
    if (option === '-i' && keyPath === null && value) {
      keyPath = value;
    } else if (option !== '-o' || !IDENTITIES_ONLY_YES.test(value ?? '')) {
      return null;
    }
  }
  if (keyPath?.startsWith('~/')) return path.join(os.homedir(), keyPath.slice(2));
  return keyPath?.startsWith('~') ? null : keyPath;
};
