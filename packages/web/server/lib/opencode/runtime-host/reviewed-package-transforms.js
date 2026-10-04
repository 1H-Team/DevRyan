import {createHash} from 'node:crypto';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export const SLIM_SERVER_SOURCE_SHA256='53c162ba1a6d767e79dc5345d316baaf3b9eb7239d0492df13b6633fc35af798';
export const REVIEWED_AST_ASSET_SHA256='5651f0c6dcbbf2f7813297f9eb8f6ba00fb4ee2d81410a8138ac6151416f31ad';

/** Build-only seams on exact original bytes. No package is loaded to transform it. */
export function rewriteReviewedSlimServer(source) {
  const sourceSHA256=hash(source);
  if(sourceSHA256!==SLIM_SERVER_SOURCE_SHA256) throw new Error('reviewed_slim_source_changed');
  let contents=Buffer.from(source).toString('utf8');const transforms=[];
  const replace=(id,start,end,replacement)=>{
    if(contents.split(start).length!==2 || contents.split(end).length!==2) throw new Error('reviewed_slim_transform_changed');
    const at=contents.indexOf(start),until=contents.indexOf(end,at+start.length);
    if(until<0) throw new Error('reviewed_slim_transform_changed');
    const original=contents.slice(at,until);
    contents=contents.slice(0,at)+replacement+contents.slice(until);
    transforms.push({id,originalSHA256:hash(original),outputSHA256:hash(replacement)});
  };
  replace('owned-logger-sink','function initLogger(sessionId) {','// src/v2/adapters.ts',
    'function initLogger(sessionId) {}\nfunction log(message, data) {\n  const serialized = data === undefined ? "" : JSON.stringify(data);\n  const entry = redactSecretsForLog(String(message) + " " + serialized);\n  for (const sink of new Set([...reviewedSlimHosts.values()].map(host => host.log))) sink(entry);\n}\n\n');
  const factorySource='v1Hooks = await OhMyOpenCodeLite(pluginInput);';
  const factoryOutput='v1Hooks = await requireReviewedSlimHost(directory).hooks(pluginInput);\n      assertReviewedSlimHooks(directory, v1Hooks);';
  if(contents.split(factorySource).length!==2)throw new Error('reviewed_slim_transform_changed');
  contents=contents.replace(factorySource,factoryOutput);
  transforms.push({id:'owned-controller-hook-factory',originalSHA256:hash(factorySource),outputSHA256:hash(factoryOutput)});
  const interviewSource='const interviewBridge = createV2InterviewBridge(ctx, interviewConfig);';
  const interviewOutput='const interviewBridge = requireReviewedSlimHost(directory).interviewBridge;';
  if(contents.split(interviewSource).length!==2)throw new Error('reviewed_slim_transform_changed');
  contents=contents.replace(interviewSource,interviewOutput);
  transforms.push({id:'owned-interview-bridge',originalSHA256:hash(interviewSource),outputSHA256:hash(interviewOutput)});
  const serviceStart='function createInterviewService(ctx, config2, deps) {';
  const serviceEnd='function createDashboardManager(ctx, config2, dashboardPort, outputFolder, options = {}) {';
  const serviceAt=contents.indexOf(serviceStart),serviceUntil=contents.indexOf(serviceEnd,serviceAt);
  let service=contents.slice(serviceAt,serviceUntil);
  service=service.replace(serviceStart,serviceStart+'\n  const documents = deps?.documents;\n  if (!documents || !deps.runtime || typeof deps.openBrowser !== "function") throw new Error("reviewed_interview_owner_required");');
  service=service.replace('deps?.openBrowser ?? openBrowser','deps.openBrowser').replace('deps?.runtime ?? createV1InterviewSessionRuntime(ctx)','deps.runtime');
  for(const [original,owned] of [['withInterviewDocumentLock','withLock'],['ensureInterviewFile','ensure'],['claimInterviewDocument','claim'],['readInterviewDocument','read'],['rewriteInterviewDocumentWithFinalSpec','rewriteFinal'],['rewriteInterviewDocument','rewrite'],['appendInterviewAnswers','appendAnswers']]){
    if(!service.includes(original+'('))throw new Error('reviewed_slim_transform_changed');
    service=service.replaceAll(original+'(','documents.'+owned+'(');
  }
  service=service.replace('const resumePath = resolveExistingInterviewPath(ctx.directory, outputFolder, idea);','const resumePath = await documents.resolveExisting(ctx.directory, outputFolder, idea);')
    .replaceAll('fs9.readFile(', 'documents.readText(').replaceAll('fs9.readdir(', 'documents.list(');
  if(service.includes('fs9.')||service.includes('const resumePath = resolveExistingInterviewPath'))throw new Error('reviewed_interview_io_unsealed');
  replace('owned-interview-document-io',serviceStart,serviceEnd,service);
  const uiStart='function renderDashboardPage(interviews, files, outputFolder) {',uiEnd='// src/interview/dashboard.ts\nfunction getAuthFilePath(port) {';
  const uiAt=contents.indexOf(uiStart),uiUntil=contents.indexOf(uiEnd,uiAt);
  if(uiAt<0||uiUntil<0)throw new Error('reviewed_interview_ui_changed');
  let ui=contents.slice(uiAt,uiUntil);
  const uiChanges=[
   [uiStart,'function renderDashboardPage(interviews, files, outputFolder, basePrefix = "") {',1],
   ['function renderInterviewPage(interviewId, resumeSlug) {','function renderInterviewPage(interviewId, resumeSlug, basePrefix = "") {',1],
   ["'/api/health'","${JSON.stringify(basePrefix)} + '/api/health'",2],
   ["'/api/settings'","${JSON.stringify(basePrefix)} + '/api/settings'",4],
   ["'/api/interviews/'","${JSON.stringify(basePrefix)} + '/api/interviews/'",6],
   ['href="/" class="back-link"','href="${escapeHtml(basePrefix + "/")}" class="back-link"',1],
  ];
  for(const [from,to,count] of uiChanges){if(ui.split(from).length!==count+1)throw new Error('reviewed_interview_ui_changed');ui=ui.replaceAll(from,to);}
  replace('owned-interview-ui-prefix',uiStart,uiEnd,ui);
  // Extract only the original HTTP handler/page/body logic. The existing web
  // server supplies fresh request authorization; no listener/election is exposed.
  const serverStart='function createInterviewServer(deps) {',handlerStart='  async function loadDashboardData() {',handlerEnd='  async function ensureStarted() {';
  const serverAt=contents.indexOf(serverStart),handlerAt=contents.indexOf(handlerStart,serverAt),handlerUntil=contents.indexOf(handlerEnd,handlerAt);
  if(serverAt<0||handlerAt<0||handlerUntil<0)throw new Error('reviewed_interview_handler_changed');
  const handlerOriginal=contents.slice(handlerAt,handlerUntil);
  const handlerBody=handlerOriginal.replace('url: `/interview/${item.id}`','url: `${basePrefix}/interview/${item.id}`').replace('renderDashboardPage(interviews, files, deps.outputFolder)','renderDashboardPage(interviews, files, deps.outputFolder, basePrefix)').replace('renderInterviewPage(rawId, extractResumeSlug(rawId))','renderInterviewPage(rawId, extractResumeSlug(rawId), basePrefix)');
  const handlerExport=`function createInterviewHandler(deps) {
  if (!deps || typeof deps.authorize !== "function") throw new Error("reviewed_interview_http_authorization_required");
  const basePrefix = deps.basePrefix ?? "";
  if (typeof basePrefix !== "string" || basePrefix !== "" && !/^(?:\\/[a-zA-Z0-9_-]+)+$/.test(basePrefix)) throw new Error("reviewed_interview_base_prefix_invalid");
${handlerBody}
  return async (request,response) => { await deps.authorize(request); return handle(request,response); };
}
`;
  transforms.push({id:'owned-interview-http-handler',originalSHA256:hash(handlerOriginal),outputSHA256:hash(handlerExport)});
  const resolverStart='function resolveExistingInterviewPath(directory, outputFolder, value) {',resolverEnd='function slugify2(value) {';
  const resolverAt=contents.indexOf(resolverStart),resolverUntil=contents.indexOf(resolverEnd,resolverAt);
  if(resolverAt<0||resolverUntil<0)throw new Error('reviewed_interview_resolver_changed');
  const resolverOriginal=contents.slice(resolverAt,resolverUntil);
  const resolverExport=resolverOriginal.replace(resolverStart,'async function resolveReviewedExistingInterviewPath(directory, outputFolder, value, deps) {\n  if (!deps || typeof deps.exists !== "function") throw new Error("reviewed_interview_path_owner_required");').replace('if (fsSync.existsSync(candidate)) {','if (await deps.exists(candidate)) {');
  if(resolverExport.includes('fsSync.'))throw new Error('reviewed_interview_resolver_unsealed');
  transforms.push({id:'owned-interview-resume-existence',originalSHA256:hash(resolverOriginal),outputSHA256:hash(resolverExport)});
  // The original observer synchronizes skills and fetches registry metadata
  // before considering autoUpdate:false. Disable the observer at construction.
  replace('owned-package-updates','function createAutoUpdateCheckerHook(ctx, options = {}) {','var hasReconciledAtStartup = false;',
    'function createAutoUpdateCheckerHook(ctx, options = {}) {\n  return { event: async () => {} };\n}\n');
  replace('frozen-slim-configuration','function loadPluginConfig(directory, options) {','  if (config2.webfetch) {',
    'function loadPluginConfig(directory, options) {\n  const saved = requireReviewedSlimConfiguration(directory);\n  const { userConfigPath, projectConfigPath } = saved;\n  let config2 = structuredClone(saved.configuration);\n');
  const envPresetSource = 'const envPreset = process.env.OH_MY_OPENCODE_SLIM_PRESET;';
  if (contents.split(envPresetSource).length !== 2) throw new Error('reviewed_slim_transform_changed');
  const envPresetOutput = 'const envPreset = requireReviewedSlimConfiguration(directory).activePreset;';
  contents = contents.replace(envPresetSource, envPresetOutput);
  transforms.push({id:'frozen-slim-preset',originalSHA256:hash(envPresetSource),outputSHA256:hash(envPresetOutput)});
  replace('no-ast-download','async function ensureAstGrepBinary() {','// src/tools/ast-grep/types.ts',
    'async function ensureAstGrepBinary() {\n  return requireReviewedAstGrepAsset();\n}\n\n');
  replace('sealed-ast-sync-resolver','function findSgCliPathSync() {','function getSgCliPath() {',
    'function findSgCliPathSync() {\n  return requireReviewedAstGrepAsset();\n}\n');
  replace('sealed-ast-resolver','function getSgCliPath() {','function setSgCliPath(path22) {',
    'function getSgCliPath() {\n  return requireReviewedAstGrepAsset();\n}\n');
  replace('no-ast-rebinding','function setSgCliPath(path22) {','var DEFAULT_TIMEOUT_MS = 300000;',
    'function setSgCliPath(path22) {\n  if (path22 !== requireReviewedAstGrepAsset()) throw new Error("reviewed_ast_asset_rebinding");\n}\n');
  replace('sealed-ast-async-resolver','async function getAstGrepPath() {','async function runSg(options) {',
    'async function getAstGrepPath() {\n  return requireReviewedAstGrepAsset();\n}\n');
  // AST 0.45.3 treats JSON + update-all as a preview. Preserve the original
  // preview/parser/formatters, then actually apply through the identical CLI.
  const applySource='  const totalMatches = matches.length;';
  const applyOutput=`  const totalMatches = matches.length;
  if (options.updateAll && totalMatches > 0) {
    const apply = crossSpawn([cliPath, ...args.filter(arg => arg !== "--json=compact")], {stdout:"pipe",stderr:"pipe"});
    let applyTimer;
    try {
      const [, applyError, applyExit] = await Promise.race([
        Promise.all([apply.stdout(), apply.stderr(), apply.exited]),
        new Promise((_, reject) => {applyTimer = setTimeout(() => {apply.kill(); reject(new Error("AST apply timeout"));}, DEFAULT_TIMEOUT_MS);})
      ]);
      if (applyExit !== 0) return {matches:[],totalMatches:0,truncated:false,error:applyError.trim() || "AST apply failed"};
    } finally {clearTimeout(applyTimer);}
  }`;
  if(contents.split(applySource).length!==2)throw new Error('reviewed_slim_transform_changed');
  contents=contents.replace(applySource,applyOutput);
  transforms.push({id:'actual-ast-apply',originalSHA256:hash(applySource),outputSHA256:hash(applyOutput)});
  // Original fetch algorithms remain intact; authority is invocation-local.
  replace('owned-webfetch-dom-loader','async function importJSDOM() {','function createJSDOMLoader(loader) {',
    'async function importJSDOM() {\n  return requireReviewedWebfetchOwner().loadJSDOM();\n}\n');
  replace('owned-webfetch-dom-scope','function loadJSDOM() {','async function probeJSDOM(load = loadJSDOM) {',
    'function loadJSDOM() {\n  return importJSDOM();\n}\n');
  replace('owned-webfetch-cache','var CACHE = new I({','function buildCacheKey(url2, options) {',
    'function createReviewedWebfetchCache() {\n  return new I({maxSize:50 * 1024 * 1024,ttl:15 * 60 * 1000,sizeCalculation:calculateCacheSize});\n}\n');
  const scopedReplace=(id,original,output)=>{
    if(contents.split(original).length!==2)throw new Error('reviewed_slim_transform_changed');
    contents=contents.replace(original,output);
    transforms.push({id,originalSHA256:hash(original),outputSHA256:hash(output)});
  };
  scopedReplace('owned-webfetch-network','const response = await fetch(current, {','const response = await requireReviewedWebfetchOwner().fetch(current, {');
  scopedReplace('owned-webfetch-cache-read','CACHE.get(cacheKey)','requireReviewedWebfetchOwner().cache.get(cacheKey)');
  scopedReplace('owned-webfetch-cache-write','CACHE.set(cacheKey, fetchResult)','requireReviewedWebfetchOwner().cache.set(cacheKey, fetchResult)');
  // The original allocator is exported only for a confined worker owner.
  scopedReplace('owned-webfetch-binary','async function saveBinary(binaryDir, data, contentType, filename) {',
    'async function saveBinary(binaryDir, data, contentType, filename) {\n  return requireReviewedWebfetchOwner().saveBinary({directory:binaryDir,data,contentType,filename});\n}\nasync function saveReviewedWebfetchBinary(binaryDir, data, contentType, filename) {');
  replace('owned-webfetch-secondary','async function runSecondaryModel(input2, model, prompt, content, parentSessionID) {','async function runSecondaryModelWithFallback(input2, models, prompt, content, parentSessionID) {',
    `async function runSecondaryModel(input2, model, prompt, content, parentSessionID) {
  const owner = requireReviewedWebfetchOwner();
  if (parentSessionID !== owner.sessionID) throw new Error("reviewed_webfetch_session_mismatch");
  const prepared = prepareInput(content, prompt);
  const text = await runWithScopedTimeout(owner.signal, SECONDARY_MODEL_TIMEOUT_MS, signal => owner.secondary({sessionID:parentSessionID,model,prompt:buildPrompt(prepared.truncatedContent,prepared.effectivePrompt),signal}));
  return {text:text.trim(),inputTruncated:prepared.inputTruncated,inputChars:prepared.inputChars,sourceChars:prepared.sourceChars};
}
`);
  scopedReplace('captured-agent-prompts','function loadAgentPrompt(agentName, optionsOrPreset) {',
    'function loadAgentPrompt(agentName, optionsOrPreset) {\n  const captured = reviewedSlimAgentData.getStore();\n  if (captured) return structuredClone(captured.prompts[agentName] ?? {});');
  // Reuse the original data configuration hook; remove only its telemetry and
  // runtime fallback side effects. The returned data keeps exact merge order.
  const configStart='    config: async (opencodeConfig) => {\n      RuntimeConfig.get(ctx.directory).captureHostConfig(opencodeConfig);';
  const configEnd='      interviewManager.registerCommand(opencodeConfig);';
  const configAt=contents.indexOf(configStart),configUntil=contents.indexOf(configEnd,configAt);
  if(configAt<0||configUntil<0||contents.split(configStart).length!==2||contents.split(configEnd).length!==2)throw new Error('reviewed_slim_configuration_changed');
  const configOriginal=contents.slice(configAt,configUntil);
  let configBody=configOriginal.slice(configStart.indexOf('\n')+1).replace('RuntimeConfig.get(ctx.directory).captureHostConfig(opencodeConfig);','runtime.captureHostConfig(opencodeConfig);');
  configBody=configBody.replace('foregroundFallback.disableChain(name);','');
  const telemetryStart='      const tuiAgentModels = {};',telemetryEnd='      applyOrchestratorModelConfig({';
  const telemetryAt=configBody.indexOf(telemetryStart),telemetryUntil=configBody.indexOf(telemetryEnd,telemetryAt);
  if(telemetryAt<0||telemetryUntil<0)throw new Error('reviewed_slim_configuration_changed');
  configBody=configBody.slice(0,telemetryAt)+configBody.slice(telemetryUntil);
  configBody=configBody.replace('      finalHostAgentConfig = configAgent;','');
  const configurationExport=`
var reviewedSlimAgentData = new ReviewedWebfetchAsyncLocalStorage();
function resolveReviewedSlimAgents(input) {
  if (!input || typeof input.directory !== "string" || !path.isAbsolute(input.directory) || !input.configuration || !input.hostConfiguration || !input.prompts || !Array.isArray(input.localSkills) || input.localSkills.some(name => typeof name !== "string")) throw new Error("reviewed_slim_agent_data_invalid");
  const captured = structuredClone(input);
  return reviewedSlimAgentData.run({prompts:captured.prompts}, () => {
    const runtime = new RuntimeConfig(captured.directory);
    // Saved/environment presets are the base layer; a TUI runtime switch would override explicit saved roles.
    if (captured.activePreset) captured.configuration.preset = captured.activePreset;
    runtime.seedPlugin(captured.configuration);
    runtime.captureHostConfig(captured.hostConfiguration);
    runtime.projectLocalSkillNames = () => [...captured.localSkills];
    const config2 = captured.configuration;
    const agents = getAgentConfigs(runtime, {projectDirectory:captured.directory,hostFlavor:"opencode-v2"});
    const mcps = structuredClone(captured.hostConfiguration.mcp ?? {});
    const opencodeConfig = structuredClone(captured.hostConfiguration);
${configBody}
    return {agents:opencodeConfig.agent,runtimeChains:structuredClone(runtime.runtimeChains),modelArrays:structuredClone(runtime.modelArrays),fallback:structuredClone(runtime.fallback),backgroundJobs:structuredClone(runtime.backgroundJobs),...opencodeConfig.default_agent === undefined ? {} : {defaultAgent:opencodeConfig.default_agent}};
  });
}
`;
  transforms.push({id:'pure-original-agent-configuration',originalSHA256:hash(configOriginal),outputSHA256:hash(configurationExport)});
  const rescueStart='function isMissing(p) {',rescueEnd='// src/hooks/apply-patch/rewrite.ts\nimport path9';
  const rescueAt=contents.indexOf(rescueStart),rescueUntil=contents.indexOf(rescueEnd,rescueAt);
  let rescue=contents.slice(rescueAt,rescueUntil);
  for(const [from,to] of [['function isMissing(p) {','async function isMissing(p) {'],['function defaultExists(p) {','async function defaultExists(p) {'],['statSync5(p);','await requireReviewedSlimPathOwner().stat(p);'],['function findRescuedSuffix(raw, workspace, pathOperations = path7, exists = defaultExists) {','async function findRescuedSuffix(raw, workspace, pathOperations = path7, exists = defaultExists) {'],['return exists(candidate) ? candidate : null;','return await exists(candidate) ? candidate : null;'],['if (!isMissing(raw))','if (!await isMissing(raw))'],['const rescued = findRescuedSuffix(raw, workspace, pathOperations, exists);','const rescued = await findRescuedSuffix(raw, workspace, pathOperations, exists);']]){
    if(!rescue.includes(from))throw new Error('reviewed_slim_path_transform_changed');rescue=rescue.replaceAll(from,to);
  }
  replace('owned-absolute-path-rescue',rescueStart,rescueEnd,rescue);
  scopedReplace('owned-patch-realpath','await fs4.realpath(current)','await requireReviewedSlimPathOwner().realpath(current)');
  scopedReplace('owned-patch-stat','await fs4.stat(filePath)','await requireReviewedSlimPathOwner().stat(filePath)');
  scopedReplace('owned-patch-read','await fs4.readFile(filePath, "utf-8")','await requireReviewedSlimPathOwner().readText(filePath)');
  scopedReplace('owned-search-path-stat','statSync7(resolved);','await requireReviewedSlimPathOwner().stat(resolved);');
  const bridgeStart='function createV2InterviewBridge(ctx, config2, options = {}) {',bridgeEnd='// src/v2/setup.ts';
  const bridgeAt=contents.indexOf(bridgeStart),bridgeUntil=contents.indexOf(bridgeEnd,bridgeAt),bridgeOriginal=contents.slice(bridgeAt,bridgeUntil);
  const registrationAt=bridgeOriginal.indexOf('  function registerCommand(draft) {');
  if(bridgeAt<0||bridgeUntil<0||registrationAt<0)throw new Error('reviewed_slim_interview_bridge_changed');
  let bridge=`function createReviewedSlimInterviewBridge(owner) {
  if (!owner || !owner.service || ["submitCommand","assertAcceptedCommand","dispose"].some(name => typeof owner[name] !== "function") || ["getActiveInterviewId","handleCommandExecuteBefore","handleEvent"].some(name => typeof owner.service[name] !== "function")) throw new Error("reviewed_slim_interview_bridge_owner_required");
  const transcripts = new Map;
  const activeText = new Map;
  const runtime = owner.runtime;
  const service = owner.service;
  const dashboardManager = null;
  const server = null;
`+bridgeOriginal.slice(registrationAt);
  const bridgeChanges=[
   ['await submitUserText(invocation?.sessionID ?? "", markerText(invocation?.prompt?.text ?? ""));','await owner.submitCommand(invocation);'],
   ['log("[v2][interview] command execute failed", String(err));','log("[v2][interview] command execute failed", String(err)); throw err;'],
   ['function isManagedInterviewSession(sessionID) {','async function isManagedInterviewSession(sessionID) {'],
   ['Boolean((dashboardManager?.service ?? service).getActiveInterviewId(sessionID))','Boolean(await service.getActiveInterviewId(sessionID))'],
   ['const managed = isManagedInterviewSession(', 'const managed = await isManagedInterviewSession('],
   ['    transcripts.set(event.sessionID, toInterviewMessages(event));\n    if (!match || trailing?.role !== "user")',
    '    if (match) {\n      if (typeof trailing?.id !== "string" || !trailing.id) throw new Error("reviewed_slim_interview_message_required");\n      await owner.assertAcceptedCommand({sessionID:event.sessionID,messageID:trailing.id,args:match[1].trim(),event});\n    }\n    transcripts.set(event.sessionID, toInterviewMessages(event));\n    if (!match || trailing?.role !== "user")'],
   ['      log("[v2][interview] bridge disposed");','      await owner.dispose();\n      log("[v2][interview] bridge disposed");']
  ];
  for(const [from,to] of bridgeChanges){if(!bridge.includes(from))throw new Error('reviewed_slim_interview_bridge_changed');bridge=bridge.replaceAll(from,to);}
  replace('owned-original-interview-bridge',bridgeStart,bridgeEnd,bridge);
  const interviewDescription=bridgeOriginal.match(/description: "([^"\n]+)"/);
  if(!interviewDescription)throw new Error('reviewed_slim_interview_declaration_changed');
  const interviewDeclaration=`const reviewedSlimInterviewCommandDeclaration=Object.freeze({description:${JSON.stringify(interviewDescription[1])},template:INTERVIEW_COMMAND_MARKER});`;

  const contextStart='function createSessionContextHandler(deps) {',contextEnd='var MAX_PROMPT_BRIDGE_SESSIONS = 1024;';
  const contextAt=contents.indexOf(contextStart),contextUntil=contents.indexOf(contextEnd,contextAt);
  let ownedContext=contents.slice(contextAt,contextUntil);
  const contextLogs=['interview context bridge','command context bridge','chat.message agent-discovery bridge','chat.headers context tracking','chat.message bridge','system transform bridge','messages transform bridge'];
  for(const label of contextLogs){
    const statement=`log("[v2] ${label} failed", String(err));`;
    if(!ownedContext.includes(statement))throw new Error('reviewed_slim_context_refusal_transform_changed');
    ownedContext=ownedContext.replace(statement,`${statement} throw err;`);
  }
  replace('owned-context-refusal-propagation',contextStart,contextEnd,ownedContext);

  scopedReplace('worker-owned-image-algorithm','function processImageAttachments(args) {','function processImageAttachments(args) {\n  requireReviewedSlimImageWorker(args.workDir);');
  const contextAlgorithms=`
var reviewedSlimImageWorkerDirectory;
function bindReviewedSlimImageWorker(directory) {
 if(typeof directory!=="string"||!path.isAbsolute(directory)||path.resolve(directory)!==directory||path.resolve(process.cwd())!==directory)throw new Error("reviewed_slim_image_worker_invalid");
 if(reviewedSlimImageWorkerDirectory&&reviewedSlimImageWorkerDirectory!==directory)throw new Error("reviewed_slim_image_worker_rebinding");
 reviewedSlimImageWorkerDirectory=directory;
}
function requireReviewedSlimImageWorker(directory) {
 if(!reviewedSlimImageWorkerDirectory||directory!==reviewedSlimImageWorkerDirectory||path.resolve(process.cwd())!==directory)throw new Error("reviewed_slim_image_worker_required");
}
function reviewedImageStatePath(logicalDirectory, relative) {
 if(typeof logicalDirectory!=="string"||!path.isAbsolute(logicalDirectory)||path.resolve(logicalDirectory)!==logicalDirectory||typeof relative!=="string"||relative.length>4096||(relative.split("/").includes("..")||relative.includes(String.fromCharCode(92)))||!(relative===".opencode/images"||relative.startsWith(".opencode/images/")))throw new Error("reviewed_slim_image_state_invalid");
 return path.join(reviewedSlimImageWorkerDirectory,relative);
}
function reviewedImageMemoInDirectory(key) {
 const target=key.split("\\n")[0],images=path.join(reviewedSlimImageWorkerDirectory,".opencode/images");return target===images||target.startsWith(images+path.sep);
}
function snapshotReviewedSlimImageState(logicalDirectory) {
 requireReviewedSlimImageWorker(reviewedSlimImageWorkerDirectory);reviewedImageStatePath(logicalDirectory,".opencode/images");
 const directory=reviewedSlimImageWorkerDirectory;
 const relative=file=>{const result=path.relative(directory,file).split(path.sep).join("/");reviewedImageStatePath(logicalDirectory,result);return result;};
 const cleanup=[...lastCleanupByDir].filter(([key])=>key===path.join(directory,".opencode/images")).map(([key,value])=>[relative(key),value]);
 const counts=[...lastProcessedUserMsgCountByDir].filter(([key])=>key.startsWith(directory+":")).map(([key,value])=>[key.slice(directory.length+1),value]);
 const resolved=[...resolvedAttachmentByKey].filter(([key])=>reviewedImageMemoInDirectory(key)).map(([key,file])=>[key.slice(directory.length),relative(file)]);
 const state={schema:1,logicalDirectory,cleanup,counts,resolved};if(counts.length>256||resolved.length>256||Buffer.byteLength(JSON.stringify(state))>256*1024)throw new Error("reviewed_slim_image_state_limit");return state;
}
function restoreReviewedSlimImageState(state,logicalDirectory) {
 requireReviewedSlimImageWorker(reviewedSlimImageWorkerDirectory);reviewedImageStatePath(logicalDirectory,".opencode/images");
 if(!state||state.schema!==1||state.logicalDirectory!==logicalDirectory||![state.cleanup,state.counts,state.resolved].every(value=>Array.isArray(value)&&value.length<=256)||Buffer.byteLength(JSON.stringify(state))>256*1024)throw new Error("reviewed_slim_image_state_invalid");
 const directory=reviewedSlimImageWorkerDirectory;
 const cleanup=state.cleanup.map(row=>{if(!Array.isArray(row)||row.length!==2||row[0]!==".opencode/images"||!Number.isFinite(row[1])||row[1]<0)throw new Error("reviewed_slim_image_state_invalid");return [reviewedImageStatePath(logicalDirectory,row[0]),row[1]];});
 const counts=state.counts.map(row=>{if(!Array.isArray(row)||row.length!==2||typeof row[0]!=="string"||row[0].length>256||row[0].includes(String.fromCharCode(0))||!Number.isSafeInteger(row[1])||row[1]<0)throw new Error("reviewed_slim_image_state_invalid");return [directory+":"+row[0],row[1]];});
 const resolved=state.resolved.map(row=>{if(!Array.isArray(row)||row.length!==2||typeof row[0]!=="string"||!row[0].startsWith("/")||row[0].length>4096)throw new Error("reviewed_slim_image_state_invalid");reviewedImageStatePath(logicalDirectory,row[0].split("\\n")[0].slice(1));return [directory+row[0],reviewedImageStatePath(logicalDirectory,row[1])];});
 for(const key of [...lastCleanupByDir.keys()])if(key===path.join(directory,".opencode/images"))lastCleanupByDir.delete(key);
 for(const key of [...lastProcessedUserMsgCountByDir.keys()])if(key.startsWith(directory+":"))lastProcessedUserMsgCountByDir.delete(key);
 for(const key of [...resolvedAttachmentByKey.keys()])if(reviewedImageMemoInDirectory(key))resolvedAttachmentByKey.delete(key);
 for(const [key,value] of cleanup)lastCleanupByDir.set(key,value);for(const [key,value] of counts)lastProcessedUserMsgCountByDir.set(key,value);for(const [key,value] of resolved)resolvedAttachmentByKey.set(key,value);
}
function selectReviewedSlimFallback(input) {
 const id="reviewed-selection",sessionTried=new Map([[id,new Set(input.tried)]]),chainExhaustion=new Map([[id,input.exhaustion]]);
 const receiver={chains:structuredClone(input.chains),sessionModel:new Map(input.currentModel===undefined?[]:[[id,input.currentModel]]),sessionAgent:new Map(input.agent===undefined?[]:[[id,input.agent]]),sessionTried,chainExhaustion,sessionRetries:new Map,lastFallbackTime:new Map,pendingInitialDelay:new Map,resolveChain:ForegroundFallbackManager.prototype.resolveChain};
 const selection=ForegroundFallbackManager.prototype.selectFallbackModel.call(receiver,id);
 return {selection:selection??null,tried:[...sessionTried.get(id)??[]],exhaustion:chainExhaustion.get(id)??0};
}
function formatReviewedSlimTaskBoard({jobs,reusable,readContextMaxFiles=8}) {
 const receiver={list:()=>jobs,listReusable:()=>reusable,readContextMaxFiles,formatReusableJob:BackgroundJobBoard.prototype.formatReusableJob,formatRetainedJob:BackgroundJobBoard.prototype.formatRetainedJob};
 return BackgroundJobBoard.prototype.formatForPromptWithMetadata.call(receiver,"reviewed-parent")??null;
}
function createReviewedSlimTaskBoardRenderer(owner) {
 if(!owner||!owner.board||typeof owner.shouldManageSession!=="function"||["get","formatForPromptWithMetadata","markReconciled"].some(name=>typeof owner.board[name]!=="function"))throw new Error("reviewed_slim_task_board_owner_required");
 const state={backgroundJobBoard:{...owner.board,markReconciled:(...args)=>{const result=owner.board.markReconciled(...args);if(result&&typeof result.then==="function")throw new Error("reviewed_slim_task_board_atomic_owner_required");return result;}},shouldManageSession:owner.shouldManageSession,strategy:owner.strategy??"latest",maxRetainedSnapshots:owner.maxRetainedSnapshots??DEFAULT_MAX_RETAINED_SNAPSHOTS,metadataKey:BACKGROUND_JOB_BOARD_METADATA_KEY,
 terminalJobsInjectedByParent:new Map,pendingInjectedTerminalJobsByParent:new Map,retainedBoardSnapshots:new Map,retainedTailBoards:new Map,reportedTerminalRunsByParent:new Map,pendingReopenCorrections:new Map};
 return {transform:(input,output)=>injectBackgroundJobBoard(state,input,output),clearSession:sessionID=>{for(const key of ["terminalJobsInjectedByParent","pendingInjectedTerminalJobsByParent","retainedBoardSnapshots","retainedTailBoards","reportedTerminalRunsByParent","pendingReopenCorrections"])state[key].delete(sessionID);}};
}
`;
  const selectionOriginal=contents.slice(contents.indexOf('  selectFallbackModel(sessionID) {'),contents.indexOf('  async execFallback(sessionID, error62) {'));
  const renderingOriginal=contents.slice(contents.indexOf('  formatForPromptWithMetadata(parentSessionID, _now) {'),contents.indexOf('  formatForPrompt(parentSessionID, now) {'))+contents.slice(contents.indexOf('async function injectBackgroundJobBoard('),contents.indexOf('function findLastMessageAnchorKey('));
  transforms.push({id:'pure-original-context-algorithms',originalSHA256:hash(selectionOriginal+renderingOriginal),outputSHA256:hash(contextAlgorithms)});
  const originalExports='export {\n  src_default as default,\n  OhMyOpenCodeLite\n};';
  if(contents.split(originalExports).length!==2) throw new Error('reviewed_slim_exports_changed');
  const replacement=`import {AsyncLocalStorage as ReviewedWebfetchAsyncLocalStorage} from "node:async_hooks";
${configurationExport}\n${interviewDeclaration}\n${contextAlgorithms}\n${handlerExport}\n${resolverExport}\nvar reviewedSlimPathOwners = new ReviewedWebfetchAsyncLocalStorage();
function withReviewedSlimPathOwner(owner, action) {
  if (!owner || ["stat","realpath","readText"].some(name => typeof owner[name] !== "function")) throw new Error("reviewed_slim_path_owner_required");
  return reviewedSlimPathOwners.run(owner, action);
}
function requireReviewedSlimPathOwner() {
  const owner=reviewedSlimPathOwners.getStore();
  if (!owner) throw new Error("reviewed_slim_path_owner_required");
  return owner;
}
var reviewedWebfetchOwners = new ReviewedWebfetchAsyncLocalStorage();
function withReviewedWebfetchOwner(owner, action) {
  return reviewedWebfetchOwners.run(owner, action);
}
function requireReviewedWebfetchOwner() {
  const owner = reviewedWebfetchOwners.getStore();
  if (!owner) throw new Error("reviewed_webfetch_owner_required");
  return owner;
}
var reviewedSlimHosts = new Map();
function bindReviewedSlimHost(input) {
  if (!input || typeof input.directory !== "string" || !path.isAbsolute(input.directory) || typeof input.hooks !== "function" || typeof input.log !== "function" || !Array.isArray(input.requiredHooks) || input.requiredHooks.some(name => typeof name !== "string") || !input.interviewBridge || ["registerCommand","handleContext","handleEvent","dispose"].some(name => typeof input.interviewBridge[name] !== "function")) throw new Error("reviewed_slim_host_invalid");
  if (reviewedSlimHosts.has(input.directory)) throw new Error("reviewed_slim_host_duplicate");
  const saved = Object.freeze({...input,requiredHooks:Object.freeze([...input.requiredHooks])});
  reviewedSlimHosts.set(input.directory, saved);
  return () => {if (reviewedSlimHosts.get(input.directory) === saved) reviewedSlimHosts.delete(input.directory);};
}
function requireReviewedSlimHost(directory) {
  const saved = reviewedSlimHosts.get(directory);
  if (!saved) throw new Error("reviewed_slim_host_unbound");
  return saved;
}
function assertReviewedSlimHooks(directory, hooks) {
  if (!hooks || typeof hooks !== "object" || requireReviewedSlimHost(directory).requiredHooks.some(name => !Object.hasOwn(hooks,name) || hooks[name] === undefined)) throw new Error("reviewed_slim_hook_missing");
}
var reviewedSlimConfigurations = new Map();
function bindReviewedSlimConfiguration(input) {
  if (!input || typeof input.directory !== "string" || !path.isAbsolute(input.directory) || !input.configuration || typeof input.configuration !== "object" || Array.isArray(input.configuration)) throw new Error("reviewed_slim_configuration_invalid");
  if (reviewedSlimConfigurations.has(input.directory)) throw new Error("reviewed_slim_configuration_duplicate");
  const saved = structuredClone(input);
  reviewedSlimConfigurations.set(input.directory, saved);
  return () => { if (reviewedSlimConfigurations.get(input.directory) === saved) reviewedSlimConfigurations.delete(input.directory); };
}
function requireReviewedSlimConfiguration(directory) {
  const saved = reviewedSlimConfigurations.get(directory);
  if (!saved) throw new Error("reviewed_slim_configuration_unbound");
  return saved;
}
var reviewedAstGrepAssetPath = null;
function bindReviewedAstGrepAsset(absolutePath) {
  if (typeof absolutePath !== "string" || !path.isAbsolute(absolutePath) || absolutePath.includes("\\0")) throw new Error("reviewed_ast_asset_invalid");
  if (reviewedAstGrepAssetPath !== null && reviewedAstGrepAssetPath !== absolutePath) throw new Error("reviewed_ast_asset_rebinding");
  reviewedAstGrepAssetPath = absolutePath;
}
function requireReviewedAstGrepAsset() {
  if (reviewedAstGrepAssetPath === null) throw new Error("reviewed_ast_asset_unbound");
  return reviewedAstGrepAssetPath;
}
export {
  src_default as default,
  OhMyOpenCodeLite,
  ast_grep_search,
  ast_grep_replace,
  bindReviewedAstGrepAsset,
  bindReviewedSlimConfiguration,
  bindReviewedSlimHost,
  createWebfetchTool,
  withReviewedWebfetchOwner,
  createReviewedWebfetchCache,
  saveReviewedWebfetchBinary,
  createInterviewService,
  createInterviewHandler,
  resolveReviewedExistingInterviewPath,
  InterviewDocumentOwnershipError,
  ensureInterviewFile,
  claimInterviewDocument,
  readInterviewDocument,
  rewriteInterviewDocument,
  rewriteInterviewDocumentWithFinalSpec,
  appendInterviewAnswers,
  resolveExistingInterviewPath,
  createDeepworkCommandHook,
  createLoopCommandHook,
  createReflectCommandHook,
  createToolLoopGuardHook,
  createJsonErrorRecoveryHook,
  createPhaseReminderHook,
  createFilterAvailableSkillsHook,
  createChatHeadersHook,
  createSessionCompactionBridge,
  collapseSystemInPlace,
  createDisplayNameMentionRewriter,
  resolveReviewedSlimAgents,
  withReviewedSlimPathOwner,
  createApplyPatchHook,
  createAbsolutePathRescueHook,
  createSearchPathGuardHook,
  createReviewedSlimInterviewBridge,
  reviewedSlimInterviewCommandDeclaration,
  selectReviewedSlimFallback,
  isFailoverError as isReviewedSlimFailoverError,
  formatReviewedSlimTaskBoard,
  createReviewedSlimTaskBoardRenderer,
  bindReviewedSlimImageWorker,
  snapshotReviewedSlimImageState,
  restoreReviewedSlimImageState,
  processImageAttachments as processReviewedSlimImageAttachments
};`;
  contents=contents.replace(originalExports,replacement);
  transforms.push({id:'owned-ast-tool-exports',originalSHA256:hash(originalExports),outputSHA256:hash(replacement)});
  return {contents,sourceSHA256,outputSHA256:hash(contents),transforms};
}
