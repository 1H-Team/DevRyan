import { createHash } from 'node:crypto';

export const REVIEWED_CLAUDE_STARTUP = Object.freeze({
  package: 'opencode-with-claude', version: '1.8.0', meridianVersion: '1.62.6',
  sourceSha256: 'b3a32d1f03047f68e39874725bc9ed40fc42b59a773acdb815e8c9b7b4025aad',
});
export const REVIEWED_CLAUDE_ASSETS = Object.freeze({
  claude: Object.freeze({path:'DevRyan-Claude-darwin-arm64',sha256:'625869b01e0050f260b2980fac248fd9cef9e462612bded4ec9d3d49ff8969a5',version:'2.1.251',mode:0o755}),
  libsql: Object.freeze({path:'DevRyan-libsql-darwin-arm64.node',sha256:'3fd9e58190311b5ee027c3e5452a6a410b31a5d610fd55853d797bb3c9f5db0c',version:'0.5.29',mode:0o644}),
});

export const REVIEWED_CLAUDE_CREDENTIALS = Object.freeze({path:'DevRyan-Claude-credentials.mjs',sourceSha256:'e98c46bef6a50d167f06a368e6ac4149fff33b0edf993219edc7c839295f52f4',sha256:'c471852fec5221957636d87cc80a4be155c74c6dda37d58d971e181cbe697c1e',mode:0o644});
/** The original renewal algorithm is used only by the host's selected-account
 * owner. No ambient refresh timer or diagnostic logger is exported. */
export function rewriteReviewedClaudeCredentials(source){
 if(createHash('sha256').update(source).digest('hex')!==REVIEWED_CLAUDE_CREDENTIALS.sourceSha256)throw new Error('native_claude_credentials_unreviewed');
 let text=Buffer.from(source).toString('utf8');
 text=text.replace('var shouldLog = () => process.env["OPENCODE_CLAUDE_PROVIDER_DEBUG"];','var shouldLog = () => false;');
 text=text.replace('function buildMacosStore(serviceName) {','function buildMacosStore(serviceName, run = execFile, fetchImpl = fetch) {');
 text=text.replaceAll('await execFile("/usr/bin/security",','await run("/usr/bin/security",');
 text=text.replace('refreshKey: `keychain:${serviceName}`,','refreshKey: `keychain:${serviceName}`,\n    fetch: fetchImpl,');
 text=text.replace('function createPlatformCredentialStore(opts) {','function createPlatformCredentialStore(opts) {\n  if (opts?.serviceName !== undefined) {\n    if (!/^Claude Code-credentials(?:-[a-f0-9]{8})?$/.test(opts.serviceName)) throw new Error("native_claude_service_invalid");\n    return buildMacosStore(opts.serviceName, opts.execFile, opts.fetch);\n  }');
 text=text.replace('response = await fetch(OAUTH_TOKEN_URL, {','response = await (store.fetch ?? fetch)(OAUTH_TOKEN_URL, {');
 text=text.replace(/export \{[^\n]+\};\s*$/, 'export {createPlatformCredentialStore, ensureFreshToken, refreshOAuthToken};\n');
 return text;
}

/** Only the captured NAPI resolver changes; the original libsql implementation remains linked. */
export function rewriteReviewedMeridianLibsql(source,{target='darwin-arm64'}={}) {
  if(!['darwin-arm64','win32-x64','win32-arm64'].includes(target))throw new Error('native_libsql_target_unreviewed');
  if(createHash('sha256').update(source).digest('hex')!=='95f3ff9cf5b4cb6fb3d530f3a06a3d70fbd6bbdaa7a06dbd9404c3cd0410abb8')throw new Error('native_meridian_source_unreviewed');
  const text=Buffer.from(source).toString('utf8'),original='return __require(`@libsql/${target}`);';
  if(text.split(original).length!==2)throw new Error('native_meridian_source_shape_changed');
  let output=text.replace(original,`const nativeAsset = globalThis.__DEVRYAN_LIBSQL_ASSET;\n    if (target !== ${JSON.stringify(target)} || typeof nativeAsset !== "string") throw new Error("native_libsql_asset_unverified");\n    return __require(nativeAsset);`);
  const marker='        const parsedOutputFormat = parseOutputFormat(body.output_config, body.tools);';
  if(output.split(marker).length!==2)throw new Error('native_meridian_source_shape_changed');
  output=output.replace(marker,`        let ownedDirectory;
        try { ownedDirectory = decodeURIComponent(c.req.header("x-devryan-directory") || ""); } catch { return c.json({error:{type:"invalid_request_error",message:"native_provider_directory_unreviewed"}},403); }
        const ownedTransport=JSON.parse(process.env.DEVRYAN_PROVIDER_TRANSPORT || "{}");
        if(ownedTransport.protocol!==1 || !ownedTransport.directories?.includes(ownedDirectory) || __require("node:fs").realpathSync(ownedDirectory)!==ownedDirectory) return c.json({error:{type:"invalid_request_error",message:"native_provider_directory_unreviewed"}},403);
${marker}`);
  const cwd='adapterCwd: adapter.extractWorkingDirectory(body) ?? adapter.extractClientWorkingDirectory?.(body),';
  if(output.split(cwd).length!==2)throw new Error('native_meridian_source_shape_changed');
  output=output.replace(cwd,'adapterCwd: ownedDirectory,').replace('envOverride: process.env.MERIDIAN_WORKDIR ?? process.env.CLAUDE_PROXY_WORKDIR,','envOverride: ownedDirectory,').replace('const clientWorkingDirectory = adapter.extractClientWorkingDirectory?.(body) || cwdResolution.claimedWorkingDirectory;','const clientWorkingDirectory = ownedDirectory;').replace('const assignmentCwd = adapter.extractClientWorkingDirectory?.(body) ?? adapter.extractWorkingDirectory(body);','const assignmentCwd = ownedDirectory;');
  const selection='        const profile = resolveProfile(finalConfig.profiles, finalConfig.defaultProfile, options.forcedProfileId || c.req.header("x-meridian-profile") || undefined, routingMode === "sticky" ? { routingMode, stickySessionKey: adapter.getSessionId(c, body) } : undefined);';
  if(output.split(selection).length!==2)throw new Error('native_meridian_source_shape_changed');
  output=output.replace(selection,selection.replace('const profile =','let profile =')+`
        const credentialResolver = globalThis.__DEVRYAN_CLAUDE_CREDENTIAL;
        if (typeof credentialResolver !== 'function') throw new Error('native_claude_credential_owner_required');
        let nativeCredential = await credentialResolver(c.req.raw, profile.id, 'request');
        if (nativeCredential) profile = {...profile, env:{...profile.env, CLAUDE_CODE_OAUTH_TOKEN:nativeCredential.accessToken}};`);
  output=output.replace('        const profileCredentialStore = credentialStoreForProfile(profile);',`        const profileCredentialStore = undefined;
        const renewNativeCredential = async () => {
          const next = await credentialResolver(c.req.raw, profile.id, 'authentication-retry', nativeCredential.fingerprint);
          if (!next) throw new Error('native_claude_credential_failed');
          nativeCredential = next; profileEnv.CLAUDE_CODE_OAUTH_TOKEN = next.accessToken; return true;
        };`);
  output=output.replaceAll('const refreshed = profileCredentialStore ? await refreshOAuthToken(profileCredentialStore) : false;','const refreshed = nativeCredential ? await renewNativeCredential() : false;');
  output=output.replace('function credentialStoreForProfile(profile) {','function credentialStoreForProfile(profile) {\n  if (process.env.DEVRYAN_EXECUTION_BOUNDARY === "1") return;');
  output=output.replace('async function ensureFreshTokenForProfiles(config) {','async function ensureFreshTokenForProfiles(config) {\n  if (process.env.DEVRYAN_EXECUTION_BOUNDARY === "1") return;');
  output=output.replace('  startBackgroundRefresh();','  if (process.env.DEVRYAN_EXECUTION_BOUNDARY !== "1") startBackgroundRefresh();');
  output=output.replace('  if (effectiveProfiles.length > 0) {','  if (effectiveProfiles.length > 0 && process.env.DEVRYAN_EXECUTION_BOUNDARY !== "1") {');
  output=output.replace('async function fetchOAuthUsageImpl(opts) {','async function fetchOAuthUsageImpl(opts) {\n  if (process.env.DEVRYAN_EXECUTION_BOUNDARY === \"1\") return {snapshot:null,error:\"no_token\"};');
  output=output.replace('const profileTokenRefreshInterval = setInterval(() => {','const profileTokenRefreshInterval = process.env.DEVRYAN_EXECUTION_BOUNDARY === \"1\" ? undefined : setInterval(() => {').replace('if (profileTokenRefreshInterval.unref)','if (profileTokenRefreshInterval?.unref)');
  return output;
}
/** Preserve the captured confinement handoff, targeting the same compiled controller. */
export function rewriteReviewedClaudeSpawn(source) {
  if(createHash('sha256').update(source).digest('hex')!=='b0b4dd45fbae18e015e6598f68187bcd4f2d9bf25396e0aec2ed7a00ecad4980')throw new Error('native_claude_spawn_unreviewed');
  const text=Buffer.from(source).toString('utf8'),start=text.indexOf('export function spawnConfinedProvider(options) {');
  if(start<0)throw new Error('native_claude_spawn_shape_changed');
  return text.slice(0,start)+`export function spawnConfinedProvider(options) {
  const transport=JSON.parse(process.env.DEVRYAN_PROVIDER_TRANSPORT || '{}');
  if(transport.protocol!==1||options.command!==transport.asset?.path||!Array.isArray(options.args))throw new Error('native_provider_transport_unverified');
  const child=spawn(process.execPath,['--claude-transport-worker','--native-instance',transport.instanceID],{stdio:['pipe','pipe','pipe'],windowsHide:true,
    env:{...options.env,DEVRYAN_PROVIDER_COMMAND:JSON.stringify({...transport,args:options.args,directory:options.cwd})}});
  const cancel=()=>child.kill('SIGTERM');options.signal?.addEventListener('abort',cancel,{once:true});
  child.once('close',()=>options.signal?.removeEventListener('abort',cancel));if(options.signal?.aborted)cancel();return child;
}\n`;
}

/** Expose the exact reviewed startup helpers; neither startup nor auth executes during transformation. */
export function rewriteReviewedClaudeStartup(source) {
  if (typeof source !== 'string' || createHash('sha256').update(source).digest('hex') !== REVIEWED_CLAUDE_STARTUP.sourceSha256) {
    throw new Error('native_claude_source_unreviewed');
  }
  const trailer = 'export{we as ClaudeMaxPlugin};';
  if (source.split(trailer).length !== 2) throw new Error('native_claude_source_shape_changed');
  // Compiled/relocated workers have no package.json discovery. This is the captured package's verified version.
  const version='i=h(),d=ee(),s=console.error';
  if(source.split(version).length!==2)throw new Error('native_claude_source_shape_changed');
  const health='fetch(R(e)+"/health",{signal:AbortSignal.timeout(5e3)})';if(source.split(health).length!==2)throw new Error('native_claude_source_shape_changed');
  const availability='if(t.status==="degraded"){';
  if(source.split(availability).length!==2)throw new Error('native_claude_source_shape_changed');
  return source.replace(health,'fetch(R(e)+"/health",{headers:{authorization:"Bearer "+process.env.DEVRYAN_PROVIDER_AUTHORIZATION},signal:AbortSignal.timeout(5e3)})').replace(availability,'if(r.status===503&&t.status==="unhealthy"&&t.auth?.loggedIn===false&&i==="1.62.6")return{ok:!0,version:i,availability:"credential-unavailable"};'+availability).replace(version,'i=h(),d="1.62.6",s=console.error').replace(trailer, 'export{we as ClaudeMaxPlugin,N as startReviewedProxy,U as checkReviewedProxy,F as resolveReviewedProfiles,R as reviewedProxyOrigin,ie as scrubReviewedSystem};');
}

/** Keep the captured HTTP compatibility adapter, adding only worker-owned admission. */
export function rewriteReviewedMeridianHttp(source){
 if(createHash('sha256').update(source).digest('hex')!=='a8812f39f18e13b5bf041c14b758edecd828b6eb195c4e9381ced25c801bfc17')throw new Error('native_meridian_http_unreviewed');
 const text=Buffer.from(source).toString('utf8'),marker='  if (!bun?.serve) return serveNode(options, onListening);';if(text.split(marker).length!==2)throw new Error('native_meridian_http_shape_changed');
 return text.replace(marker,`  const fetch=request=>typeof globalThis.__DEVRYAN_MERIDIAN_AUTHORIZATION==='function' && globalThis.__DEVRYAN_MERIDIAN_AUTHORIZATION(request)?options.fetch(request):new Response(JSON.stringify({error:{type:'permission_error',message:'native_provider_attempt_required'}}),{status:403,headers:{'content-type':'application/json'}});
  if (!bun?.serve) return serveNode({...options,fetch}, onListening);`).replace('    fetch: options.fetch,','    fetch,');
}
