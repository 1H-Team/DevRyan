// The recorded argument vectors. Every vector here is one the CLI finishes before it reaches
// serve/stop/restart/update/enroll-owner/tunnel network paths/runtime resume (see the classification in MAP.md).
import fs from 'node:fs';
// Fixture state for the private home (seed.sh copies a case's ./home into it). Pids of processes that are
// NOT running (each is checked free before recording; replay may meet a reused pid: status and logs only
// read and print, and the logs cases with a positive pid use --no-follow). Ports 1 and 9: nothing listens there.
const D = 'home/.config/devryan';
const FREE_PIDS = [99971, 99973];
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const profile = (over = {}) => ({ id: 'p-1', name: 'prod-main', provider: 'cloudflare', mode: 'managed-remote', hostname: 'app.example.com', originPort: 3000, token: 'fake-token-aaaa1111', createdAt: 1600000000000, updatedAt: 1600000000500, ...over });
const store = (profiles, extra = {}) => JSON.stringify({ version: 2, profiles, ...extra }, null, 2);
const TWO = store([profile(), profile({ id: 'p-2', name: 'Staging', provider: 'CloudFlare ', mode: ' Managed-Remote', hostname: ' stage.example.com ', originPort: '1024', token: ' fake-token-bbbb2222 ', createdAt: 1.5, updatedAt: -0 })]);
const MIXED = store([
  profile({ id: 'k-1', name: 'kept', originPort: '0x400', createdAt: 1e21, updatedAt: 12 }),
  profile({ id: 'k-2', name: 'KEPT', token: 'dup' }), // same provider and lower-case name: dropped
  profile({ id: 'k-3', name: 'other-provider', provider: 'ngrok', originPort: 80 }),
  profile({ id: 'k-4', name: 'kept', provider: 'ngrok', originPort: 1024.5, token: 'x' }),
  { id: 'n-1', name: 'no-token', provider: 'cloudflare', mode: 'managed-remote', hostname: 'h.example.com' },
  { id: 'n-2', name: 'no-host', provider: 'cloudflare', mode: 'managed-remote', token: 'fake' },
  { name: '', provider: 'cloudflare', mode: 'managed-remote', hostname: 'h', token: 't' },
  null, 7, 'text', [1, 2],
  profile({ id: '  ', name: 'unicode-ünï', hostname: 'ü.example.com', token: 'tökén-ßß', originPort: 'abc', createdAt: 5, updatedAt: 6 }),
]);
const NO_ID = store([profile({ id: undefined, name: 'no-id' })]);
const NO_TIME = store([profile({ createdAt: 'yesterday', name: 'no-time' })]);
const fixtures = {
  staleRecords: {
    [`${D}/run/devryan-3000.pid`]: 'not-a-pid\n', [`${D}/run/devryan-3000.json`]: '{"launchMode":"daemon","startedAt":1}',
    [`${D}/run/devryan-3001.pid`]: '0', [`${D}/run/openchamber-3002.pid`]: '  -7  ',
    [`${D}/run/devryan-3003.pid`]: '', [`${D}/run/devryan-3004.pid.b64`]: b64([0xff, 0xfe, 0x80]),
    [`${D}/run/devryan-0.pid`]: String(FREE_PIDS[0]), [`${D}/run/devryan-70000.pid`]: String(FREE_PIDS[0]),
    [`${D}/run/notes.txt`]: 'not a record', [`${D}/run/devryan-x.pid`]: '1',
  },
  freePidRecords: {
    [`${D}/run/devryan-9.pid`]: String(FREE_PIDS[0]), [`${D}/run/devryan-9.json`]: '{"launchMode":"daemon"}',
    [`${D}/run/openchamber-1.pid`]: `${FREE_PIDS[1]}\n`, [`${D}/run/openchamber-1.json`]: '{"launchMode":"foreground"}',
  },
  recordIsFolder: { [`${D}/run/devryan-3005.pid/inner`]: '' },
  settingsNoPort: { [`${D}/settings.json`]: '{"theme":"dark"}' },
  settingsBadPorts: { [`${D}/settings.json`]: '{"desktopLocalPort":"3000","desktopLocalPort2":1}' },
  settingsZero: { [`${D}/settings.json`]: '{"desktopLocalPort":0}' },
  settingsTooLarge: { [`${D}/settings.json`]: '{"desktopLocalPort":70000}' },
  settingsMalformed: { [`${D}/settings.json`]: '{"desktopLocalPort": 30' },
  settingsArray: { [`${D}/settings.json`]: '[3000]' },
  logsShapes: {
    [`${D}/run/devryan-3000.pid`]: 'stale', [`${D}/logs/devryan-3000.log`]: '',
    [`${D}/logs/devryan-3001.log`]: Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n') + '\n',
    [`${D}/logs/devryan-3002.log.b64`]: b64([0x6f, 0x6b, 0x0a, 0xc3, 0x28, 0x0a, 0xff, 0x0a]),
    [`${D}/logs/devryan-3001.log.1`]: 'rotated\n', [`${D}/logs/openchamber-3003.log`]: 'legacy\n',
  },
  profilesTwo: { [`${D}/tunnel-profiles.json`]: TWO, 'home.modes': '600 .config/devryan/tunnel-profiles.json\n' },
  profilesTwoWorldReadable: { [`${D}/tunnel-profiles.json`]: TWO, 'home.modes': '644 .config/devryan/tunnel-profiles.json\n' },
  profilesMixed: { [`${D}/tunnel-profiles.json`]: MIXED, 'home.modes': '600 .config/devryan/tunnel-profiles.json\n' },
  profilesMalformed: { [`${D}/tunnel-profiles.json`]: '{"version":2,"profiles":[', 'home.modes': '640 .config/devryan/tunnel-profiles.json\n' },
  profilesNotArray: { [`${D}/tunnel-profiles.json`]: '{"version":2,"profiles":{"a":1}}', 'home.modes': '600 .config/devryan/tunnel-profiles.json\n' },
  profilesNull: { [`${D}/tunnel-profiles.json`]: 'null', 'home.modes': '600 .config/devryan/tunnel-profiles.json\n' },
  profilesVersion1: { [`${D}/tunnel-profiles.json`]: store([profile()], { version: 1 }), 'home.modes': '600 .config/devryan/tunnel-profiles.json\n' },
  profilesNoId: { [`${D}/tunnel-profiles.json`]: NO_ID, 'home.modes': '600 .config/devryan/tunnel-profiles.json\n' },
  profilesNoTime: { [`${D}/tunnel-profiles.json`]: NO_TIME, 'home.modes': '600 .config/devryan/tunnel-profiles.json\n' },
  profilesBadUtf8: { [`${D}/tunnel-profiles.json.b64`]: b64(Buffer.concat([Buffer.from('{"version":2,"profiles":[{"id":"b","name":"bytes","provider":"cloudflare","mode":"managed-remote","hostname":"h.example.com","token":"ab'), Buffer.from([0xff, 0xc3]), Buffer.from('cd","createdAt":1,"updatedAt":2}]}')])), 'home.modes': '600 .config/devryan/tunnel-profiles.json\n' },
  legacyWithEntries: { [`${D}/cloudflare-managed-remote-tunnels.json`]: JSON.stringify({ version: 2, tunnels: [{ id: 'l', name: 'legacy', hostname: 'l.example.com', token: 'fake-legacy', originPort: 3000, updatedAt: 1 }] }) },
  legacyWithoutEntries: { [`${D}/cloudflare-managed-remote-tunnels.json`]: JSON.stringify({ version: 2, tunnels: [{ name: 'no-token', hostname: 'x' }, null] }) },
  profilesFolder: { [`${D}/tunnel-profiles.json/inner`]: '' },
};
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
  // object-prototype names, the rest of them
  ['proto-valueOf', ['valueOf']], ['proto-isPrototypeOf', ['isPrototypeOf']], ['proto-propertyIsEnumerable', ['propertyIsEnumerable']],
  ['proto-toLocaleString', ['toLocaleString']], ['proto-defineGetter', ['__defineGetter__']], ['proto-defineSetter', ['__defineSetter__']],
  ['proto-lookupGetter', ['__lookupGetter__']], ['proto-lookupSetter', ['__lookupSetter__']], ['proto-dunder-json', ['__proto__', '--json']],
  ['proto-defineGetter-json', ['--json', '__defineGetter__']], ['proto-toString-json', ['toString', '--json']],
  // fixture state in the private home
  ['status-stale-records', ['status'], 'staleRecords'], ['status-stale-records-json', ['status', '--json'], 'staleRecords'],
  ['status-stale-records-quiet', ['status', '-q'], 'staleRecords'], ['status-free-pids', ['status'], 'freePidRecords'],
  ['status-free-pids-json', ['status', '--json'], 'freePidRecords'], ['status-record-folder', ['status'], 'recordIsFolder'],
  ['status-settings-no-port', ['status', '--json'], 'settingsNoPort'], ['status-settings-string-port', ['status'], 'settingsBadPorts'],
  ['status-settings-zero', ['status', '-q'], 'settingsZero'], ['status-settings-too-large', ['status'], 'settingsTooLarge'],
  ['status-settings-malformed', ['status', '--json'], 'settingsMalformed'], ['status-settings-array', ['status'], 'settingsArray'],
  ['logs-stale-records', ['logs'], 'staleRecords'], ['logs-stale-records-json', ['logs', '--json', '--no-follow'], 'staleRecords'],
  ['logs-stale-records-port', ['logs', '--port', '3000'], 'staleRecords'], ['logs-free-pids', ['logs', '--no-follow'], 'freePidRecords'],
  ['logs-free-pids-all', ['logs', '--all', '--no-follow', '--json'], 'freePidRecords'], ['logs-shapes', ['logs', '--no-follow'], 'logsShapes'],
  ['logs-shapes-all', ['logs', '--all', '--lines', '3'], 'logsShapes'], ['logs-shapes-port-json', ['logs', '--port', '3001', '--json', '--no-follow'], 'logsShapes'],
  ['profile-list-two', ['tunnel', 'profile', 'list'], 'profilesTwo'], ['profile-list-two-json', ['tunnel', 'profile', 'list', '--json'], 'profilesTwo'],
  ['profile-list-two-quiet', ['tunnel', 'profile', 'list', '-q'], 'profilesTwo'], ['profile-list-two-secrets', ['tunnel', 'profile', 'list', '--show-secrets'], 'profilesTwo'],
  ['profile-list-two-secrets-json', ['tunnel', 'profile', 'list', '--json', '--show-secrets'], 'profilesTwo'],
  ['profile-list-two-provider', ['tunnel', 'profile', 'list', '--provider', ' CLOUDFLARE '], 'profilesTwo'],
  ['profile-list-two-other-provider', ['tunnel', 'profile', 'list', '--provider', 'ngrok', '--json'], 'profilesTwo'],
  ['profile-show-two', ['tunnel', 'profile', 'show', '--name', 'staging'], 'profilesTwo'],
  ['profile-show-two-json', ['tunnel', 'profile', 'show', '--name', ' prod-main ', '--json'], 'profilesTwo'],
  ['profile-show-two-quiet-secrets', ['tunnel', 'profile', 'show', '--name', 'PROD-MAIN', '-q', '--show-secrets'], 'profilesTwo'],
  ['profile-show-two-provider-miss', ['tunnel', 'profile', 'show', '--name', 'staging', '--provider', 'ngrok'], 'profilesTwo'],
  ['profile-show-no-name-two', ['tunnel', 'profile', 'show', '--name', '  '], 'profilesTwo'],
  ['profile-remove-missing-two', ['tunnel', 'profile', 'remove', '--name', 'ghost', '--json'], 'profilesTwo'],
  ['profile-remove-existing-two', ['tunnel', 'profile', 'remove', '--name', 'staging'], 'profilesTwo'],
  ['profile-bare-two', ['tunnel', 'profile', '  '], 'profilesTwo'], ['profile-unknown-two', ['tunnel', 'profile', 'LISTS'], 'profilesTwo'],
  ['profile-list-world-readable', ['tunnel', 'profile', 'list'], 'profilesTwoWorldReadable'],
  ['profile-list-world-readable-json', ['tunnel', 'profile', 'list', '--json'], 'profilesTwoWorldReadable'],
  ['profile-list-world-readable-quiet', ['tunnel', 'profile', 'list', '--quiet'], 'profilesTwoWorldReadable'],
  ['profile-unknown-world-readable', ['tunnel', 'profile', 'nope'], 'profilesTwoWorldReadable'],
  ['profile-list-mixed', ['tunnel', 'profile', 'list'], 'profilesMixed'], ['profile-list-mixed-json', ['tunnel', 'profile', 'list', '--json'], 'profilesMixed'],
  ['profile-list-mixed-quiet', ['tunnel', 'profile', 'list', '-q'], 'profilesMixed'],
  ['profile-show-mixed-ambiguous', ['tunnel', 'profile', 'show', '--name', 'kept'], 'profilesMixed'],
  ['profile-show-mixed-unicode-json', ['tunnel', 'profile', 'show', '--name', 'UNICODE-ÜNÏ', '--json'], 'profilesMixed'],
  ['profile-list-malformed', ['tunnel', 'profile', 'list'], 'profilesMalformed'], ['profile-list-malformed-json', ['tunnel', 'profile', 'list', '--json'], 'profilesMalformed'],
  ['profile-list-not-array', ['tunnel', 'profile', 'list', '--json'], 'profilesNotArray'], ['profile-list-null', ['tunnel', 'profile', 'list', '--json'], 'profilesNull'],
  ['profile-list-version-1', ['tunnel', 'profile', 'list', '--json'], 'profilesVersion1'],
  ['profile-list-no-id', ['tunnel', 'profile', 'list'], 'profilesNoId'], ['profile-list-no-id-json', ['tunnel', 'profile', 'list', '--json'], 'profilesNoId'],
  ['profile-list-no-time-quiet', ['tunnel', 'profile', 'list', '-q'], 'profilesNoTime'], ['profile-list-no-time-json', ['tunnel', 'profile', 'list', '--json'], 'profilesNoTime'],
  ['profile-list-bad-utf8', ['tunnel', 'profile', 'list', '--json', '--show-secrets'], 'profilesBadUtf8'],
  ['profile-list-legacy-entries', ['tunnel', 'profile', 'list', '--json'], 'legacyWithEntries'],
  ['profile-list-legacy-without-entries', ['tunnel', 'profile', 'list', '--json'], 'legacyWithoutEntries'],
  ['profile-list-store-folder', ['tunnel', 'profile', 'list'], 'profilesFolder'],
];
const names = new Set();
for (const [name] of cases) { if (names.has(name)) throw new Error(`duplicate ${name}`); names.add(name); }
for (const [name, , fixture] of cases) if (fixture && !fixtures[fixture]) throw new Error(`${name}: no fixture ${fixture}`);
// A positive pid in a fixture reaches process.kill(pid, 0); logs must then not follow.
for (const [name, args, fixture] of cases) {
  if (fixture === 'freePidRecords' && args[0] === 'logs' && !args.includes('--no-follow')) throw new Error(`${name}: logs with live-looking pids must use --no-follow`);
}
fs.writeFileSync('inputs.jsonl', cases.map(([name, args, fixture]) => JSON.stringify(fixture ? { name, args, files: fixtures[fixture] } : { name, args })).join('\n') + '\n');
fs.writeFileSync('free-pids.txt', `${FREE_PIDS.join('\n')}\n`);
fs.writeFileSync('allowed.txt', cases.map(([, args]) => args.map((a) => `${a}\t`).join('')).join('\n') + '\n');
console.log(cases.length);
