// The recorded argument vectors. Every vector here is one the CLI finishes before it reaches
// serve/stop/restart/update/enroll-owner/tunnel network paths/runtime resume (see the classification in MAP.md).
import fs from 'node:fs';
const cases = [
  // version: printed before anything else
  ['version-long', ['--version']], ['version-short', ['-v']], ['version-json', ['--version', '--json']], ['version-short-json', ['-v', '--json']],
  ['version-after-serve', ['serve', '--version']], ['version-after-tunnel', ['tunnel', 'start', '-v']], ['version-quiet', ['--quiet', '--version']],
  ['version-with-unknown-flag', ['--version', '--bogus']], ['version-plain', ['--plain', '-v']],
  // help
  ['help-long', ['--help']], ['help-short', ['-h']], ['help-serve', ['serve', '--help']], ['help-stop', ['stop', '--help']],
  ['help-restart', ['restart', '-h']], ['help-status', ['status', '--help']], ['help-logs', ['logs', '--help']], ['help-update', ['update', '--help']],
  ['help-enroll-owner', ['enroll-owner', '--help']], ['help-runtime', ['runtime', '--help']], ['help-json', ['--help', '--json']], ['help-plain', ['--plain', '--help']],
  ['help-unknown-command', ['frobnicate', '--help']], ['help-port', ['--port', '4000', '--help']], ['help-foreground', ['--foreground', '-h']],
  ['help-tunnel-flag', ['tunnel', '--help']], ['help-tunnel-start-flag', ['tunnel', 'start', '--help']], ['help-tunnel-profile-flag', ['tunnel', 'profile', 'add', '-h']],
  ['tunnel-bare', ['tunnel']], ['tunnel-help', ['tunnel', 'help']], ['tunnel-help-json', ['tunnel', 'help', '--json']],
  // removed and unknown flags (after the data-root migration, before help)
  ['removed-try-cf-tunnel', ['--try-cf-tunnel']], ['removed-tunnel-qr', ['--tunnel-qr']], ['removed-tunnel-password-url', ['--tunnel-password-url']],
  ['removed-tunnel-provider', ['--tunnel-provider', 'cloudflare']], ['removed-tunnel-mode', ['serve', '--tunnel-mode', 'quick']], ['removed-tunnel-config', ['--tunnel-config']],
  ['removed-tunnel-token', ['--tunnel-token=abc']], ['removed-tunnel-hostname', ['--tunnel-hostname', 'x.example.com']], ['removed-tunnel', ['--tunnel']],
  ['removed-json', ['--try-cf-tunnel', '--json']], ['removed-several', ['--tunnel', '--tunnel-qr', '-z']], ['removed-several-json', ['--json', '--tunnel', '--frob']],
  ['removed-with-help', ['--help', '--tunnel']], ['unknown-long', ['--frobnicate']], ['unknown-short', ['-x']], ['unknown-short-cluster', ['-pq']],
  ['unknown-inline-value', ['--frob=1']], ['unknown-json', ['--json', '--nope']], ['unknown-with-status', ['status', '--nope']],
  ['unknown-empty-long', ['--']], ['unknown-dash', ['-']], ['unknown-with-version-later', ['--nope', '-h']],
  ['expected-revision-not-runtime', ['--expected-revision', '3']], ['expected-revision-status', ['status', '--expected-revision=3']],
  ['expected-revision-json', ['logs', '--expected-revision', '1', '--json']],
  // argument errors thrown by the parser (before the migration)
  ['port-missing', ['--port']], ['port-missing-short', ['-p']], ['port-empty-inline', ['--port=']], ['port-not-number', ['--port', 'abc']],
  ['port-not-number-inline', ['--port=12a']], ['port-zero', ['--port', '0']], ['port-negative', ['-p', '-1']], ['port-too-large', ['--port', '70000']],
  ['port-negative-inline', ['--port=-5']], ['port-flag-next', ['--port', '--json']], ['port-error-json', ['--json', '--port', 'x']],
  ['port-error-before-version', ['--port', '0', '--version']], ['port-float', ['--port', '80.5']],
  ['host-missing', ['--host']], ['host-blank-inline', ['--host=  ']], ['host-flag-next', ['--host', '--json']],
  ['origin-port-missing', ['tunnel', 'start', '--origin-port']], ['origin-port-not-number', ['--origin-port', 'abc']],
  ['origin-port-too-small', ['--origin-port', '80']], ['origin-port-negative', ['--origin-port', '-5']], ['origin-port-too-large', ['--origin-port=70000']],
  ['origin-port-json', ['--json', '--origin-port', '1']],
  // unknown commands
  ['unknown-command', ['frobnicate']], ['unknown-command-suggest-status', ['statsu']], ['unknown-command-suggest-tunnel', ['tunel']],
  ['unknown-command-suggest-serve', ['SERV']], ['unknown-command-help-word', ['help']], ['unknown-command-version-word', ['version']],
  ['unknown-command-json', ['frobnicate', '--json']], ['unknown-command-suggest-json', ['stopp', '--json']], ['unknown-command-unicode', ['stätus']],
  ['unknown-command-enroll', ['enrol-owner']],
  // tunnel: pure subcommands and errors
  ['tunnel-completion-default', ['tunnel', 'completion']], ['tunnel-completion-bash', ['tunnel', 'completion', 'bash']],
  ['tunnel-completion-zsh', ['tunnel', 'completion', 'zsh']], ['tunnel-completion-fish', ['tunnel', 'completion', 'fish']],
  ['tunnel-completion-upper', ['tunnel', 'completion', 'ZSH']], ['tunnel-completion-unsupported', ['tunnel', 'completion', 'powershell']],
  ['tunnel-completion-unsupported-json', ['tunnel', 'completion', 'nu', '--json']], ['tunnel-completion-json', ['tunnel', 'completion', 'bash', '--json']],
  ['tunnel-unknown', ['tunnel', 'frobnicate']], ['tunnel-unknown-suggest', ['tunnel', 'provders']], ['tunnel-unknown-suggest-json', ['tunnel', 'statu', '--json']],
  ['tunnel-unknown-quiet', ['tunnel', 'strat', '-q']],
  // tunnel profile: read-only on the empty private store
  ['tunnel-profile-bare', ['tunnel', 'profile']], ['tunnel-profile-bare-json', ['tunnel', 'profile', '--json']], ['tunnel-profile-bare-quiet', ['tunnel', 'profile', '--quiet']],
  ['tunnel-profile-list', ['tunnel', 'profile', 'list']], ['tunnel-profile-list-json', ['tunnel', 'profile', 'list', '--json']],
  ['tunnel-profile-list-quiet', ['tunnel', 'profile', 'list', '--quiet']], ['tunnel-profile-list-provider', ['tunnel', 'profile', 'list', '--provider', 'cloudflare', '--json']],
  ['tunnel-profile-show-no-name', ['tunnel', 'profile', 'show']], ['tunnel-profile-show-missing', ['tunnel', 'profile', 'show', '--name', 'ghost']],
  ['tunnel-profile-show-missing-json', ['tunnel', 'profile', 'show', '--name', 'ghost', '--json']],
  ['tunnel-profile-remove-no-name', ['tunnel', 'profile', 'remove']], ['tunnel-profile-remove-missing', ['tunnel', 'profile', 'remove', '--name', 'ghost']],
  ['tunnel-profile-unknown', ['tunnel', 'profile', 'lst']], ['tunnel-profile-unknown-far', ['tunnel', 'profile', 'zzzzzzz']],
  // status and logs with no instance (empty private run folder)
  ['status', ['status']], ['status-json', ['status', '--json']], ['status-quiet', ['status', '--quiet']], ['status-quiet-short', ['status', '-q']],
  ['status-plain', ['status', '--plain']],
  ['logs-none', ['logs']], ['logs-none-no-follow', ['logs', '--no-follow']], ['logs-none-json', ['logs', '--json']], ['logs-none-json-no-follow', ['logs', '--json', '--no-follow']],
  ['logs-none-all', ['logs', '--all']], ['logs-none-port', ['logs', '--port', '4000']], ['logs-none-quiet', ['logs', '-q', '--lines', '5']],
  // runtime: argument validation that refuses before the bundle owner is reached
  ['runtime-bare', ['runtime']], ['runtime-bundle', ['runtime', 'bundle']], ['runtime-resume-no-revision', ['runtime', 'bundle', 'resume']],
  ['runtime-resume-bad-revision', ['runtime', 'bundle', 'resume', '--expected-revision', 'abc']], ['runtime-resume-zero', ['runtime', 'bundle', 'resume', '--expected-revision=0']],
  ['runtime-resume-other-flag', ['runtime', 'bundle', 'resume', '--port', '3000', '--expected-revision', '1']],
  ['runtime-resume-duplicate', ['runtime', 'bundle', 'resume', '--expected-revision', '1', '--expected-revision', '2']],
  ['runtime-resume-extra', ['runtime', 'bundle', 'resume', 'now', '--expected-revision', '1']], ['runtime-bad-json', ['runtime', 'bundle', '--json']],
  ['runtime-bad-quiet', ['runtime', '-q']], ['runtime-resume-huge', ['runtime', 'bundle', 'resume', '--expected-revision', '99999999999999999999']],
  // traps: object-prototype names as commands, odd option spellings, JavaScript number and whitespace rules
  ['proto-toString', ['toString']], ['proto-constructor', ['constructor']], ['proto-dunder', ['__proto__']], ['proto-hasOwnProperty', ['hasOwnProperty']],
  ['short-dash-long-name', ['-port', '0']], ['long-dash-short-name', ['--p=0']], ['version-inline-value', ['--version=x']], ['short-json-removed', ['-json', '--tunnel']],
  ['port-huge', ['--port', '99999999999999999999999']], ['port-huge-negative', ['--port=-123456789012345678901234']], ['port-minus-zero', ['--port=-0']],
  ['port-zeros', ['--port', '0000']], ['port-nel', ['--port', '\u008580']], ['port-bom', ['--port', '\ufeff0']], ['port-21-digits', ['--port', '100000000000000000000']],
  ['origin-port-1023', ['--host', 'x', '--origin-port', '1023']], ['origin-port-huge', ['--origin-port', '1000000000000000000000000']],
  ['lines-not-consuming-flag', ['logs', '--lines', '--tunnel']], ['ui-password-no-value', ['--ui-password', '--frob']],
  ['tunnel-unknown-case', ['tunnel', 'Help']], ['tunnel-completion-empty', ['tunnel', 'completion', '']], ['tunnel-completion-spaces', ['tunnel', 'completion', ' fish ']],
  ['runtime-negative-revision', ['runtime', 'bundle', 'resume', '--expected-revision', '-1']], ['runtime-json-first', ['--json', 'runtime']],
  ['unknown-command-quote', ['it\'s']], ['unknown-command-json-escape', ['a"b\\c\u0001', '--json']], ['removed-json-escape', ['--json', '--x"y']],
];
const names = new Set();
for (const [name] of cases) { if (names.has(name)) throw new Error(`duplicate ${name}`); names.add(name); }
fs.writeFileSync('inputs.jsonl', cases.map(([name, args]) => JSON.stringify({ name, args })).join('\n') + '\n');
fs.writeFileSync('allowed.txt', cases.map(([, args]) => args.map((a) => `${a}\t`).join('')).join('\n') + '\n');
console.log(cases.length);
