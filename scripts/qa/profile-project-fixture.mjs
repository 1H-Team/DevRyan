// Disposable analogue of the original user request, never the original website.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { captureFixtureManifest } from '../agent-evals/fixture.mjs';
import { createRunRoot } from './run-root.mjs';
import { assertQaPrivateDirectory, readQaPinnedFile } from './live-setup-mirror.mjs';
import { createQaHostLaunchEnvironment } from './launch-environment.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const owned = new WeakMap();
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = code => Object.assign(new Error(code), { code });

export const ORIGINAL_PROFILE_QA_USER_TEXT = "On mobile, when I view the website as a signed out user, the chat button in the bottom right moves up and down as if there is a nav bar, but there are none as a signed out user. I'm not sure if it's me or if it's the nav bar, the input field for the URL of the browser that makes it move,\u00a0 Also, when I view the website in dark mode in web, I want you to fix a different issue about the tab list that has the different sections within the page. In dark mode, there is a white background to the selected section within the tab list, so I want you to fix that as well. Also the background fill for the qualifications and certifications it's blue-ish instead of the darker version V1 for professional license how the background fill and the border looks that's what I want for the qualifications and certifications. Make sure any changes that are done here if they're applicable on the professional profile live editor That's in dashboard / professional / profile make sure that they're applied there as well. Also still in dark mode when I'm scrolling up and down the public profiles for professionals, clinics, or services, the section that has the breadcrumbs, the share button, and the button for favorites there's a dark section a dot a dark background fill that stretches the whole width of that section whenever I'm scrolling up and down, which shouldn't be happening. So I want you to remove that as well or fix it. make a plan to fix All of this";

export const PROFILE_QA_HELD_OUT_CASES = Object.freeze([
  { id: 'signed-out-mobile-viewport', inputs: [844, 760, 844].map(visualViewportHeight => ({ theme: 'dark', signedIn: false,
    layoutViewportHeight: 844, visualViewportHeight, scrolled: true, surface: 'professional' })),
  expected: { chatBottom: 16, navigationVisible: false } },
  { id: 'dark-and-light-style-regression', inputs: ['dark', 'light'].map(theme => ({ theme, signedIn: false,
    layoutViewportHeight: 900, visualViewportHeight: 900, scrolled: false, surface: 'professional' })),
  expectedByInput: [{ selectedTabFill: '#222b38', qualificationFill: '#131a24', qualificationBorder: '#344055',
    certificationFill: '#131a24', certificationBorder: '#344055' },
  { selectedTabFill: '#e8edf3', qualificationFill: '#ffffff', qualificationBorder: '#cdd5df',
    certificationFill: '#ffffff', certificationBorder: '#cdd5df' }] },
  { id: 'public-routes-editor-scroll-parity', inputs: ['professional', 'clinic', 'service', 'editor'].flatMap(surface =>
    [false, true].map(scrolled => ({ theme: 'dark', signedIn: surface === 'editor', layoutViewportHeight: 844,
      visualViewportHeight: 844, scrolled, surface }))),
  expected: { headerFill: 'transparent', selectedTabFill: '#222b38', qualificationFill: '#131a24',
    qualificationBorder: '#344055', certificationFill: '#131a24', certificationBorder: '#344055' } },
]);

const appearanceSource = `export function profileAppearance({theme, signedIn, layoutViewportHeight, visualViewportHeight, scrolled, surface}) {
  const dark = theme === 'dark';
  return { navigationVisible: signedIn, chatBottom: 16 + 64 + Math.max(0, layoutViewportHeight - visualViewportHeight),
    selectedTabFill: dark ? '#ffffff' : '#e8edf3',
    licenseFill: dark ? '#131a24' : '#ffffff', licenseBorder: dark ? '#344055' : '#cdd5df',
    qualificationFill: dark ? '#19395c' : '#ffffff', qualificationBorder: dark ? '#315981' : '#cdd5df',
    certificationFill: dark ? '#19395c' : '#ffffff', certificationBorder: dark ? '#315981' : '#cdd5df',
    headerFill: dark && scrolled ? '#101723' : 'transparent' };
}
`;
const instruction = 'This is a disposable DevRyan QA analogue, not the original project. Work only in this repository. No dependencies, commits, installed accounts or external access. Preserve docs/user-notes.md exactly. Inspect src/profile-appearance.mjs with native read before execution. Plan mode permits inspection and owned plan persistence only; do not edit implementation/tests before UI approval. After approval run standalone node --test test/profile.test.mjs before edits, then repeat after the final edit and run npm test. Keep existing tests unchanged and add behavior regressions in separate files. Public profiles and the professional live editor share the same appearance contract. Browser viewport, both themes and scrolling need independent actual browser evidence; do not claim those checks from unit tests. Plans belong in .opencode/plans/. The original assembled historical prompt is unavailable; the supplied user text is exact, with new fixture context appended.';

const seedFiles = () => ({
  'package.json': JSON.stringify({ name: 'devryan-qa-public-profile', private: true, type: 'module',
    scripts: { test: 'node --test test/*.test.mjs', start: 'node src/server.mjs' } }, null, 2) + '\n',
  'AGENTS.md': '# Disposable profile QA\n\n' + instruction + '\n',
  'README.md': '# Profile website QA analogue\n\nRun npm test and npm start. The server prints its dynamic loopback URL. Routes: /professionals/demo, /clinics/demo, /services/demo and /dashboard/professional/profile. Theme controls switch both themes. Public routes default signed out; ?signedIn=1 shows the actual bottom navigation. Shared src/profile-appearance.mjs owns visual tokens and viewport positioning; public/app.js applies it to public routes and the editor. No provider, identity, or account service is implemented. Known defects are intentionally seeded.\n',
  'docs/user-notes.md': '# User note\n\nPreserve the shared professional-license dark reference.\n',
  'src/profile-appearance.mjs': appearanceSource,
  'public/index.html': '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Public profile QA</title><link rel="stylesheet" href="/style.css"></head><body><header id="profile-header"><nav aria-label="Breadcrumbs">Directory / Profile</nav><button>Share</button><button aria-label="Favorite profile">Favorite</button></header><main><h1 id="profile-title"></h1><label for="theme">Theme</label><select id="theme"><option value="light">Light</option><option value="dark">Dark</option></select><div role="tablist" aria-label="Profile sections"><button role="tab" aria-selected="true">Overview</button><button role="tab" aria-selected="false">Credentials</button></div><section class="card" id="license"><h2>Professional license V1</h2><p>Reference license</p></section><section class="card" id="qualifications"><h2>Qualifications</h2><p>Professional qualification</p></section><section class="card" id="certifications"><h2>Certifications</h2><p>Professional certification</p></section><label for="profile-bio">Professional profile description</label><textarea id="profile-bio">Profile description</textarea><div class="scroll-spacer" aria-hidden="true"></div></main><nav id="bottom-nav" aria-label="Signed-in navigation">Dashboard</nav><button id="chat" aria-label="Open chat">Chat</button><script type="module" src="/app.js"></script></body></html>\n',
  'public/style.css': 'html{color-scheme:light}body{margin:0;font:16px system-ui;background:#f5f7fa;color:#172033}body[data-theme=dark]{background:#0c1119;color:#e8edf3;color-scheme:dark}main{max-width:48rem;margin:0 auto;padding:1rem}#profile-header{position:sticky;top:0;display:flex;align-items:center;gap:1rem;padding:1rem}#profile-header nav{flex:1}button,select,textarea{font:inherit;padding:.65rem;border:1px solid #344055;border-radius:.4rem}button{cursor:pointer}button:focus-visible,select:focus-visible,textarea:focus-visible{outline:3px solid #9cc8ff;outline-offset:3px}[role=tablist]{display:flex;gap:.5rem;margin:1rem 0}.card{border:1px solid;border-radius:.5rem;padding:1rem;margin:1rem 0}textarea{box-sizing:border-box;width:100%}#chat{position:fixed;right:16px}#bottom-nav{position:fixed;bottom:0;left:0;right:0;height:64px;background:#222b38}.scroll-spacer{height:140vh}[hidden]{display:none!important}\n',
  'public/app.js': `import {profileAppearance} from '/appearance.js';
const surface = location.pathname.includes('/dashboard/') ? 'editor' : location.pathname.startsWith('/clinics/') ? 'clinic' : location.pathname.startsWith('/services/') ? 'service' : 'professional';
const signedIn = surface === 'editor' || new URLSearchParams(location.search).get('signedIn') === '1';
const theme = document.querySelector('#theme'); theme.value = new URLSearchParams(location.search).get('theme') === 'dark' ? 'dark' : 'light';
document.querySelector('#profile-title').textContent = surface === 'editor' ? 'Professional live editor' : surface + ' public profile';
document.querySelector('#profile-bio').readOnly = surface !== 'editor';
const apply = () => {
 const styles=profileAppearance({theme:theme.value,signedIn,layoutViewportHeight:window.innerHeight,visualViewportHeight:window.visualViewport?.height??window.innerHeight,scrolled:window.scrollY>0,surface});
 document.body.dataset.theme=theme.value;document.querySelector('#bottom-nav').hidden=!styles.navigationVisible;
 document.querySelector('#chat').style.bottom='calc('+styles.chatBottom+'px + env(safe-area-inset-bottom, 0px))';
 document.querySelector('[role=tab][aria-selected=true]').style.background=styles.selectedTabFill;
 document.querySelector('#profile-header').style.background=styles.headerFill;
 for(const [id,prefix] of [['license','license'],['qualifications','qualification'],['certifications','certification']]){
  const card=document.querySelector('#'+id);card.style.background=styles[prefix+'Fill'];card.style.borderColor=styles[prefix+'Border'];
 }
};theme.addEventListener('change',apply);window.addEventListener('scroll',apply,{passive:true});window.addEventListener('resize',apply);window.visualViewport?.addEventListener('resize',apply);apply();
`,
  'src/server.mjs': `import{createServer}from'node:http';import{readFile}from'node:fs/promises';import{fileURLToPath}from'node:url';
const assets={'/app.js':['../public/app.js','text/javascript'],'/style.css':['../public/style.css','text/css'],'/appearance.js':['./profile-appearance.mjs','text/javascript']};
const routes=new Set(['/','/professionals/demo','/clinics/demo','/services/demo','/dashboard/professional/profile']);
const server=createServer(async(req,res)=>{const url=new URL(req.url,'http://127.0.0.1');const asset=assets[url.pathname]??(routes.has(url.pathname)?['../public/index.html','text/html']:undefined);if(req.method!=='GET'||!asset){res.writeHead(404);res.end();return;}try{const bytes=await readFile(fileURLToPath(new URL(asset[0],import.meta.url)));res.writeHead(200,{'content-type':asset[1]});res.end(bytes);}catch{res.writeHead(500);res.end();}});
server.listen(Number(process.env.PORT??0),'127.0.0.1',()=>console.log('http://127.0.0.1:'+server.address().port));for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>server.close());
`,
  'test/profile.test.mjs': `import assert from'node:assert/strict';import{test}from'node:test';import{profileAppearance}from'../src/profile-appearance.mjs';
const input={theme:'dark',signedIn:false,layoutViewportHeight:844,visualViewportHeight:844,scrolled:false,surface:'professional'};
test('signed-out chat has no phantom navigation offset across viewport changes',()=>{for(const visualViewportHeight of[844,760])assert.equal(profileAppearance({...input,visualViewportHeight}).chatBottom,16);});
test('dark selected tabs use the dark selected surface',()=>assert.equal(profileAppearance(input).selectedTabFill,'#222b38'));
test('qualifications and certifications match professional license fill and border',()=>{const value=profileAppearance(input);for(const prefix of['qualification','certification']){assert.equal(value[prefix+'Fill'],value.licenseFill);assert.equal(value[prefix+'Border'],value.licenseBorder);}});
test('public profile header remains transparent while scrolling',()=>{for(const surface of['professional','clinic','service'])assert.equal(profileAppearance({...input,surface,scrolled:true}).headerFill,'transparent');});
test('professional live editor shares dark credential appearance',()=>{const value=profileAppearance({...input,surface:'editor',signedIn:true});assert.equal(value.certificationFill,value.licenseFill);});
`,
});

export async function createQaProfileProjectFixture({ outputRoot = path.join(repository, '.cache/qa'), runId = 'profile-original', keepArtifacts = true } = {}) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(runId)) throw fail('qa_profile_fixture_input_invalid');
  outputRoot = path.resolve(outputRoot);
  // A fresh checkout may lack .cache/qa, or another tool may have created it 0755: make the default parent private.
  if (outputRoot === path.join(repository, '.cache/qa')) {
    await fs.mkdir(outputRoot, { recursive: true, mode: 0o700 });
    await fs.chmod(outputRoot, 0o700);
  }
  await assertQaPrivateDirectory(outputRoot);
  const run = createRunRoot({ parent: outputRoot, prefix: `${runId}-`, owner: 'scripts/qa/profile-project-fixture.mjs',
    keepArtifacts, extraPayloads: ['project'], signals: false });
  const fixtureRoot = path.join(run.dir, 'project'); await fs.mkdir(fixtureRoot, { mode: 0o700 });
  try {
    const files = seedFiles();
    for (const [relative, content] of Object.entries(files)) {
      const file = path.join(fixtureRoot, relative); await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await fs.writeFile(file, content, { flag: 'wx', mode: 0o600 });
    }
    const environment = createQaHostLaunchEnvironment({ HOME: fixtureRoot, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' });
    const git = async args => (await promisify(execFile)('/usr/bin/git', args, { cwd: fixtureRoot, env: environment, timeout: 10000 })).stdout.trim();
    const template = path.join(run.dir, 'git-template'); await fs.mkdir(template, { mode: 0o700 });
    await git(['init', '-q', '--initial-branch=qa-profile', `--template=${template}`]); await git(['add', '.']);
    await git(['-c', 'user.name=DevRyan QA', '-c', 'user.email=qa@devryan.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Seed disposable public-profile QA analogue']);
    await fs.appendFile(path.join(fixtureRoot, 'docs/user-notes.md'), '\nUser edit: keep this note and the shared license reference.\n');
    const originalUserText = ORIGINAL_PROFILE_QA_USER_TEXT;
    const seed = { schemaVersion: 1, seedVersion: 1, revision: await git(['rev-parse', 'HEAD']), branch: 'qa-profile',
      manifest: captureFixtureManifest(fixtureRoot), protectedPaths: ['docs/user-notes.md', 'AGENTS.md'], planPrefixes: ['.opencode/plans/'] };
    const seedManifestPath = path.join(run.dir, 'seed-manifest.json'); const seedBytes = JSON.stringify(seed, null, 2) + '\n';
    await fs.writeFile(seedManifestPath, seedBytes, { flag: 'wx', mode: 0o600 });
    await fs.writeFile(path.join(run.dir, 'input-context.json'), JSON.stringify({ originalUserText, originalUserTextSha256: digest(originalUserText),
      context: 'disposable-analogue-different-repository', historicalAssembledPrompt: 'unavailable',
      requestedSelections: { orchestrator: { model: 'openai/gpt-6-astra', variant: 'medium' }, explorer: { model: 'cursor-acp/grok-4.6', variant: 'medium' } },
      inference: 'not-run', browserVerification: 'not-run' }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await fs.writeFile(path.join(run.dir, 'held-out-cases.json'), JSON.stringify(PROFILE_QA_HELD_OUT_CASES, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    const fixture = Object.freeze({ fixtureRoot, evidenceDirectory: run.dir, seedManifestPath, seedManifestSha256: digest(seedBytes), seed,
      attachments: [], originalUserText, prompts: Object.freeze({ initial: originalUserText + '\n\nQA repository context:\n' + instruction,
        approve: 'Implement the current saved plan through its actual approval control, preserving the user note. Run the initial failing standalone test before implementation edits, then verify the repair and full suite. Independent browser checks remain pending until actually observed.',
        continue: 'Continue this approved profile repair from authoritative saved plan, task results and repository state. Preserve the user note, avoid repeating completed work and report actual verification.' }) });
    const stat = await fs.lstat(fixtureRoot); owned.set(fixture, { dev: stat.dev, ino: stat.ino, run }); return fixture;
  } catch (error) { run.finish('failed'); throw error; }
}

export async function assertQaProfileProjectFixtureOwned(fixture) {
  const identity = owned.get(fixture); if (!identity) throw fail('qa_profile_fixture_owner_invalid');
  await assertQaPrivateDirectory(fixture.fixtureRoot); const stat = await fs.lstat(fixture.fixtureRoot);
  if (stat.dev !== identity.dev || stat.ino !== identity.ino) throw fail('qa_profile_fixture_owner_invalid');
  await readQaPinnedFile(fixture.seedManifestPath, fixture.seedManifestSha256, 4 * 1024 * 1024);
}

export async function finishQaProfileProjectFixture(fixture, status = 'interrupted') {
  await assertQaProfileProjectFixtureOwned(fixture); owned.get(fixture).run.finish(status); owned.delete(fixture);
}
