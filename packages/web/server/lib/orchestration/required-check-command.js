import path from 'node:path';

export const REQUIRED_CHECK_COMMAND_HINT = 'Run the check as a standalone command or an && chain; do not append echo, use pipelines, shell wrappers, substitutions or other shell control operators.';
const ambiguous = 'required_check_command_exit_ambiguous';
const shells = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh', 'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe']);
const control = new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'select', 'function', 'eval', 'source', '.', 'return', 'exit', 'exec', 'trap', 'alias', 'builtin', 'command', 'coproc']);

// This recognizes only argv commands joined by &&. It is deliberately not a
// shell interpreter: unsupported syntax cannot establish positive exit proof.
export function requiredCheckCommandIssue(command) {
  if (typeof command !== 'string' || !command.trim() || /[\r\n\0]/.test(command)) return ambiguous;
  const commands = [], words = [];
  let word = '', quote = null, started = false;
  const finishWord = () => { if (started) words.push(word); word = ''; started = false; };
  const finishCommand = () => { finishWord(); if (!words.length) return false; commands.push(words.splice(0)); return true; };
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote === "'") {
      if (char === "'") quote = null; else word += char;
      continue;
    }
    if (char === '\\') {
      if (++i === command.length) return ambiguous;
      // In double quotes only these characters can be escaped by the shell.
      if (quote === '"' && !['$', '`', '"', '\\'].includes(command[i])) word += '\\';
      word += command[i]; started = true; continue;
    }
    if (char === '$' || char === '`') return ambiguous;
    if (quote === '"') {
      if (char === '"') quote = null; else word += char;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; started = true; continue; }
    if (/\s/.test(char)) { finishWord(); continue; }
    if (char === '&' && command[i + 1] === '&') {
      if (!finishCommand()) return ambiguous;
      i++; continue;
    }
    if (';|&<>(){}!#'.includes(char)) return ambiguous;
    word += char; started = true;
  }
  if (quote || !finishCommand()) return ambiguous;
  for (const argv of commands) {
    const executable = argv.findIndex(value => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(value));
    if (executable < 0 || !argv[executable] || control.has(argv[executable])) return ambiguous;
    if (path.basename(argv[executable]) === 'env' && argv.slice(executable + 1).some(value => value === '-S' || value.startsWith('--split-string'))) return ambiguous;
    // Reject indirect shell entrypoints too (env/command/timeout sh -c ...).
    // Their own exit status need not represent the declared check.
    if (argv.slice(executable).some(value => shells.has(path.basename(value).toLowerCase()))) return ambiguous;
  }
  return null;
}
