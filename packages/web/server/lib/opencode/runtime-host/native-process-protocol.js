import path from 'node:path';
import { createHash } from 'node:crypto';
import {parseClaudeLifecycleOperation} from './native-claude-lifecycle.js';

export const NATIVE_PROCESS_PROTOCOL = 1;
export const NATIVE_PROCESS_LIMITS = Object.freeze({ bootBytes: 4 * 1024 * 1024, messageBytes: 64 * 1024, recordBytes:32*1024*1024, inFlight: 32 });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = () => Object.assign(new Error('Invalid native process protocol'), { code: 'native_process_protocol_invalid' });
const keys = (value, allowed) => { if (!record(value) || Object.keys(value).some(key => !allowed.includes(key))) throw invalid(); };
const string = value => { if (typeof value !== 'string' || !value || value.includes('\0') || value.length > 8192) throw invalid(); return value; };
const digest = value => { if (!/^[a-f0-9]{64}$/.test(string(value))) throw invalid(); return value; };
const absolute = value => { if (!path.isAbsolute(string(value))) throw invalid(); return value; };
const array = (value, check) => { if (!Array.isArray(value) || value.length > 4096) throw invalid(); return value.map(check); };
const catalogSelection = (value, availability = false) => {
  keys(value, ['source', 'providerID', 'modelID', 'variant', ...(availability ? ['directory', 'status', 'reason'] : [])]);
  keys(value.source, ['kind', 'id', 'index']);
  if (!['model', 'agent', 'backup', 'command', 'councillor', 'slim-route', 'slim-fallback', 'requirement'].includes(value.source.kind)) throw invalid();
  if (value.source.id !== undefined) string(value.source.id);
  if (value.source.index !== undefined && (!Number.isSafeInteger(value.source.index) || value.source.index < 0)) throw invalid();
  string(value.providerID); string(value.modelID);
  if (value.variant !== null) string(value.variant);
  if (availability) {
    absolute(value.directory);
    const reasons = { available: [null], unavailable: ['provider_missing', 'model_missing', 'variant_missing'], unknown: ['catalog_unavailable'] };
    if (!Object.hasOwn(reasons, value.status) || !reasons[value.status].includes(value.reason)) throw invalid();
  }
  return value;
};
const catalogRequirements = (value, location = false) => {
  keys(value, ['agents', 'plugins', 'tools', 'models', 'selections', ...(location ? ['skills', 'commands', 'mcp'] : [])]);
  if (value.selections !== undefined) array(value.selections, selection => catalogSelection(selection));
  for (const name of ['agents', 'plugins', 'tools', ...(location ? ['skills', 'commands', 'mcp'] : [])]) array(value[name], string);
  array(value.models, model => {
    keys(model, ['providerID', 'id', 'variant']); string(model.providerID); string(model.id);
    if (model.variant !== undefined) string(model.variant);
    return model;
  });
};
const sessionID = value => { if (!/^ses[0-9A-Za-z_-]{1,128}$/.test(string(value))) throw invalid(); return value; };
const permit = value => { keys(value, ['token', 'sessionID', 'revision']); digest(value.token); if (value.sessionID !== undefined) sessionID(value.sessionID); if (!Number.isSafeInteger(value.revision) || value.revision < 0) throw invalid(); return value; };
const bounded = (value, max) => { const text = JSON.stringify(value); if (text === undefined || Buffer.byteLength(text) > max) throw invalid(); return value; };
const oauth = value => {
  keys(value, ['type', 'methodID', 'access', 'refresh', 'expires', 'metadata']);
  if (value.type !== 'oauth' || !['chatgpt-browser', 'chatgpt-headless'].includes(value.methodID)
    || !Number.isSafeInteger(value.expires) || value.metadata !== undefined && !record(value.metadata)) throw invalid();
  string(value.access); string(value.refresh); return value;
};
const selectedOAuth = value => {
  keys(value, ['controllerInstanceID', 'directory', 'credentialID', 'integrationID', 'value']);
  string(value.controllerInstanceID); absolute(value.directory); string(value.credentialID);
  if (value.integrationID !== 'openai') throw invalid();
  oauth(value.value); return value;
};
const credentialMutation = value => {
  const identifier = item => { if (!/^[A-Za-z0-9_-]{1,256}$/.test(string(item))) throw invalid(); };
  const label = item => { if (typeof item !== 'string' || item.length > 8192 || item.includes('\0')) throw invalid(); };
  if (value?.operation === 'create') {
    keys(value, ['operation', 'input']);
    keys(value.input, ['integrationID', 'value', 'id', 'label', 'activate']);
    if (!['openai', 'cursor-acp', 'xai', 'opencode', 'opencode-go'].includes(value.input.integrationID)) throw invalid();
    keys(value.input.value, ['type', 'key']);
    if (value.input.value.type !== 'key') throw invalid();
    string(value.input.value.key);
    if (value.input.id !== undefined) identifier(value.input.id);
    if (value.input.label !== undefined) label(value.input.label);
    if (value.input.activate !== undefined && typeof value.input.activate !== 'boolean') throw invalid();
  } else if (value?.operation === 'update') {
    keys(value, ['operation', 'id', 'updates']); identifier(value.id);
    keys(value.updates, ['label']); label(value.updates.label);
  } else if (['activate', 'remove'].includes(value?.operation)) {
    keys(value, ['operation', 'id']); identifier(value.id);
  } else throw invalid();
};

/** The data descriptor supplies configuration; executable registrations remain compiled. */
export function parseNativeBoot(value) {
  bounded(value, NATIVE_PROCESS_LIMITS.bootBytes);
  keys(value, ['protocol', 'type', 'bundleID', 'instanceID', 'buildId', 'manifestSha256', 'databasePath', 'globals', 'directory', 'locations', 'bridge', 'httpToken', 'configuration', 'configurationSnapshot', 'reviewedPlugins', 'migrationEvidence', 'catalogRequirements', 'cursorCatalog','recoveredSessionIDs']);
  if(value.recoveredSessionIDs!==undefined){array(value.recoveredSessionIDs,sessionID);if(value.recoveredSessionIDs.length>128||new Set(value.recoveredSessionIDs).size!==value.recoveredSessionIDs.length)throw invalid();}
  if (value.protocol !== 1 || value.type !== 'boot') throw invalid();
  string(value.bundleID); string(value.instanceID); digest(value.buildId); digest(value.manifestSha256); absolute(value.databasePath); absolute(value.directory);
  keys(value.globals, ['home', 'config', 'data', 'state', 'cache', 'bin', 'log', 'repos', 'tmp']);
  for (const key of ['home', 'config', 'data', 'state', 'cache', 'bin', 'log', 'repos', 'tmp']) absolute(value.globals[key]);
  array(value.locations, location => { keys(location, ['directory', 'readRoots', 'protectedRoots']); absolute(location.directory); array(location.readRoots, absolute); array(location.protectedRoots, absolute); if (!location.readRoots.length) throw invalid(); return location; });
  if (!value.locations.length || new Set(value.locations.map(item => item.directory)).size !== value.locations.length || !value.locations.some(item => item.directory === value.directory)) throw invalid();
  keys(value.bridge, ['url', 'token']);
  const url = new URL(string(value.bridge.url));
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.hash) throw invalid();
  for (const token of [value.bridge.token, value.httpToken]) if (!/^[a-zA-Z0-9_-]{32,256}$/.test(string(token))) throw invalid();
  if (!record(value.configuration)) throw invalid();
  if (value.configurationSnapshot !== undefined) {
    const snapshot = value.configurationSnapshot;
    keys(snapshot, ['schema', 'revision', 'digest', 'sourceStamp', 'registrationManifestDigest', 'locations']);
    if (snapshot.schema !== 1 || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1) throw invalid();
    digest(snapshot.digest); digest(snapshot.sourceStamp); digest(snapshot.registrationManifestDigest);
    array(snapshot.locations, location => {
      if (!record(location) || !record(location.configuration) || !record(location.compatibility) || !record(location.requiredCatalogs)) throw invalid();
      absolute(location.directory);
      catalogRequirements(location.requiredCatalogs, true);
      for (const name of ['skills', 'aliases', 'activePlugins']) if (!Array.isArray(location[name])) throw invalid();
      return location;
    });
    if (snapshot.locations.length !== value.locations.length || new Set(snapshot.locations.map(location => location.directory)).size !== value.locations.length
      || snapshot.locations.some(location => !value.locations.some(allowed => allowed.directory === location.directory))) throw invalid();
    const { digest: expected, ...body } = snapshot;
    if (createHash('sha256').update(JSON.stringify(body)).digest('hex') !== expected) throw invalid();
  }
  array(value.reviewedPlugins, origin => { keys(origin, ['id', 'manifestDigest', 'capabilities']); string(origin.id); digest(origin.manifestDigest); array(origin.capabilities, capability => { if (!['read', 'write', 'process', 'network', 'managed-task', 'control', 'provider'].includes(capability)) throw invalid(); return capability; }); return origin; });
  keys(value.migrationEvidence, ['path', 'sha256', 'clone']); absolute(value.migrationEvidence.path); digest(value.migrationEvidence.sha256);
  if (value.migrationEvidence.clone !== undefined) {
    const proof = value.migrationEvidence.clone; keys(proof, ['preparedManifestPath', 'preparedManifestSha256']);
    absolute(proof.preparedManifestPath); digest(proof.preparedManifestSha256);
    const root = path.dirname(path.dirname(value.migrationEvidence.path));
    if (value.migrationEvidence.path !== path.join(root, 'sources/migration.json') || proof.preparedManifestPath !== path.join(root, 'prepared.json')
      || value.databasePath !== path.join(root, 'opencode/opencode.db')) throw invalid();
  }
  catalogRequirements(value.catalogRequirements);
  if (value.cursorCatalog !== undefined) {
    keys(value.cursorCatalog, ['id', 'models']);
    if (value.cursorCatalog.id !== 'cursor-acp') throw invalid();
    const modelIDs = new Set();
    array(value.cursorCatalog.models, model => {
      keys(model, ['id', 'variants']); string(model.id);
      if (model.id.length > 256 || modelIDs.has(model.id)) throw invalid();
      modelIDs.add(model.id);
      const variants = array(model.variants, string);
      if (variants.length > 256 || new Set(variants).size !== variants.length || variants.some(id => id.length > 256)) throw invalid();
      return model;
    });
  }
  return structuredClone(value);
}

export function parseNativeCommand(value) {
  bounded(value, value?.action==='cursor-record-owned'?NATIVE_PROCESS_LIMITS.recordBytes:NATIVE_PROCESS_LIMITS.messageBytes);
  if (!record(value) || value.protocol !== 1) throw invalid();
  string(value.id);
  const fields = { open: [], 'open-recovery': [], 'close-startup': [], quiesce: [], close: [], hold: ['sessionID'], release: ['sessionID'],
    'wake-owned': ['sessionID', 'permit'], 'wake-deferred-owned': ['sessionID', 'permit'],
    'acquire-retention-owned':['sessionID','permit'],'archive-retention-owned':['sessionID','permit','at'],
    'queued-primary-idle-owned':['sessionID','messageID','permit'], 'inspect-removal-owned': ['sessionID', 'permit'], 'remove-leaf-owned': ['intentID', 'sessionID', 'permit'],
    'credential-commit-owned': ['callID', 'controllerInstanceID', 'bindingFingerprint'],
    'credential-operation-owned': ['directory', 'controllerInstanceID', 'requestAuthorization', 'mutation'],
    'credential-metadata-owned': ['directory', 'controllerInstanceID', 'integrationID'],
    'claude-lifecycle-read-owned':['controllerInstanceID'],
    'claude-lifecycle-transition-owned':['controllerInstanceID','expectedRevision','operation'],
    'provider-catalog-selection-owned': ['directory', 'controllerInstanceID', 'integrationID', 'acquisitionID', 'configurationDigest', 'origin'],
    'openai-read-selected-owned': ['directory', 'controllerInstanceID'],
    'openai-cas-selected-owned': ['directory', 'controllerInstanceID', 'expected', 'next'],
    'interview-action-owned':['sessionID','permit','kind','body'],
    'cursor-record-owned':['controllerInstanceID','directory','sessionID','userMessageID','assistantMessageID','agent','modelID','variant','accepted','record','permit'],
    'cursor-settle-owned':['controllerInstanceID','directory','sessionID','userMessageID','assistantMessageID','agent','modelID','variant','permit'],
    'cursor-key-owned':['controllerInstanceID','directory','sessionID','userMessageID','assistantMessageID','agent','modelID','variant','permit'],
    'cursor-readonly-key-owned':['controllerInstanceID','directory','sessionID','kind','permit'],
    'reconcile-shell-owned': ['sessionID', 'messageID', 'permit'], 'reconcile-primary-owned': ['sessionID', 'messageID', 'permit'],
    'cancel-recovered-input-owned':['sessionID','messageID','payloadHash','enqueuedSeq','cancellationReceiptVersion','permit'], 'recover-shell-owned': ['sessionID', 'jobID'] };
  if (!Object.hasOwn(fields, value.action)) throw invalid();
  keys(value, ['protocol', 'id', 'action', ...fields[value.action]]);
  for (const field of fields[value.action]) {
    if(field==='messageID'&&value.action==='queued-primary-idle-owned'&&value.messageID===undefined)continue;
    if(field==='variant'){if(value.variant!==undefined)string(value.variant);continue;}
    if (field === 'sessionID') { if(value.action!=='cursor-readonly-key-owned'||value.sessionID!==undefined)sessionID(value[field]); }
    else if(field==='at'){if(!Number.isSafeInteger(value[field])||value[field]<=0)throw invalid();}
    else if(field==='expectedRevision'){if(!Number.isSafeInteger(value[field])||value[field]<0)throw invalid();}
    else if(field==='operation'){try{parseClaudeLifecycleOperation(value[field]);}catch{throw invalid();}}
    else if(field==='enqueuedSeq'){if(!Number.isSafeInteger(value[field])||value[field]<0)throw invalid();}
    else if(field==='cancellationReceiptVersion'){if(value[field]!==1)throw invalid();}
    else if (field === 'permit') permit(value[field]);
    else if (field === 'directory') absolute(value[field]);
    else if (field === 'bindingFingerprint' || field === 'requestAuthorization' || field === 'configurationDigest'||field==='payloadHash') digest(value[field]);
    else if (field === 'origin') { keys(value.origin, ['id', 'manifestDigest']); if (value.origin.id !== 'devryan.provider-compat') throw invalid(); digest(value.origin.manifestDigest); }
    else if(field==='kind'){if(!(value.action==='cursor-readonly-key-owned'?['title','text','catalog','verify']:['rename','notify','continue']).includes(value.kind))throw invalid();
      if(value.action==='cursor-readonly-key-owned'&&(value.kind==='title'?!value.sessionID:value.sessionID!==undefined))throw invalid();}
    else if(field==='body'){
      const body=value.body;keys(body,value.kind==='rename'?['sessionID','title']:value.kind==='notify'?['sessionID','id','text','resume']:['sessionID','id','text']);
      if(body.sessionID!==value.sessionID)throw invalid();
      if(value.kind==='rename')string(body.title);else{string(body.id);if(!/^msg[A-Za-z0-9_-]+$/.test(body.id))throw invalid();if(typeof body.text!=='string'||!body.text||Buffer.byteLength(body.text)>1024*1024)throw invalid();}
      if(value.kind==='notify'&&body.resume!==false)throw invalid();
    }
    else if (field === 'mutation') credentialMutation(value[field]);
    else if (field === 'expected') selectedOAuth(value[field]);
    else if (field === 'next') oauth(value[field]);
    else if(field==='accepted'){
      keys(value.accepted,['id','text','files','agents','metadata','delivery','resume']);
      if(value.accepted.id!==value.userMessageID||typeof value.accepted.text!=='string'||!record(value.accepted.metadata)
        ||!['queue','steer'].includes(value.accepted.delivery)||value.accepted.resume!==undefined&&value.accepted.resume!==false
        ||value.accepted.files!==undefined&&!Array.isArray(value.accepted.files)||value.accepted.agents!==undefined&&!Array.isArray(value.accepted.agents))throw invalid();
    }
    else if(field==='record'){
      keys(value.record,['info','parts']);
      if(!record(value.record.info)||!Array.isArray(value.record.parts)||value.record.parts.length>4096||value.record.info.sessionID!==value.sessionID
        ||value.record.info.role==='user'&&value.record.info.id!==value.userMessageID
        ||value.record.info.role==='assistant'&&(value.record.info.id!==value.assistantMessageID||value.record.info.parentID!==value.userMessageID)
        ||!['user','assistant'].includes(value.record.info.role))throw invalid();
    }
    else string(value[field]);
  }
  if (value.permit?.sessionID !== undefined && value.permit.sessionID !== value.sessionID) throw invalid();
  if (value.action === 'provider-catalog-selection-owned' && (value.integrationID !== 'github-copilot' || value.acquisitionID.length > 256)) throw invalid();
  if (value.action === 'openai-cas-selected-owned' && (value.expected.directory !== value.directory
    || value.expected.controllerInstanceID !== value.controllerInstanceID || value.expected.value.methodID !== value.next.methodID)) throw invalid();
  return structuredClone(value);
}

export function parseNativeReply(value) {
  bounded(value, NATIVE_PROCESS_LIMITS.messageBytes);
  if (!record(value) || value.protocol !== 1) throw invalid();
  if (value.type === 'bound') {
    keys(value, ['protocol', 'type', 'bundleID', 'instanceID', 'url', 'port', 'buildId', 'catalog', 'migration']);
    string(value.bundleID); string(value.instanceID); digest(value.buildId);
    const url = new URL(string(value.url));
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65535 || Number(url.port) !== value.port) throw invalid();
    if (!record(value.catalog) || typeof value.catalog.asserted !== 'boolean' || !record(value.migration) || !['completed', 'not-needed'].includes(value.migration.v1)) throw invalid();
    if (value.catalog.availability !== undefined) {
      keys(value.catalog.availability, ['selections']);
      array(value.catalog.availability.selections, selection => catalogSelection(selection, true));
    }
  } else {
    keys(value, ['protocol', 'id', 'ok', 'result', 'error']); string(value.id);
    if (typeof value.ok !== 'boolean') throw invalid();
    if (!value.ok) { keys(value.error, ['code', 'status', 'message']); string(value.error.code); string(value.error.message); if (!Number.isSafeInteger(value.error.status) || value.error.status < 400 || value.error.status > 599) throw invalid(); }
    if (value.ok && value.error !== undefined || !value.ok && value.result !== undefined) throw invalid();
  }
  return structuredClone(value);
}

export function encodeNativeProcessMessage(value) {
  bounded(value, value?.type === 'boot' ? NATIVE_PROCESS_LIMITS.bootBytes : value?.action==='cursor-record-owned'?NATIVE_PROCESS_LIMITS.recordBytes:NATIVE_PROCESS_LIMITS.messageBytes);
  return `${JSON.stringify(value)}\n`;
}

export function parseNativeMigrationRequest(value) {
  bounded(value, NATIVE_PROCESS_LIMITS.bootBytes);
  keys(value, ['protocol', 'requestID', 'bundleID', 'candidateDatabasePath', 'isolatedRoot', 'receiptPath', 'auxiliary', 'projectMap']);
  if (value.protocol !== 'devryan-native-migration/1') throw invalid();
  string(value.requestID); string(value.bundleID);
  for (const field of ['candidateDatabasePath', 'isolatedRoot', 'receiptPath']) absolute(value[field]);
  if (value.auxiliary?.kind === 'absent') keys(value.auxiliary, ['kind']);
  else { keys(value.auxiliary, ['kind', 'databasePath', 'sha256']); if (value.auxiliary.kind !== 'copy') throw invalid(); absolute(value.auxiliary.databasePath); digest(value.auxiliary.sha256); }
  array(value.projectMap, mapping => { keys(mapping, ['sourceDirectory', 'targetDirectory', 'mode']); absolute(mapping.sourceDirectory); absolute(mapping.targetDirectory); if (!['identity', 'synthetic-copy'].includes(mapping.mode)) throw invalid(); return mapping; });
  return structuredClone(value);
}

export function parseNativeMigrationReceipt(value) {
  bounded(value, NATIVE_PROCESS_LIMITS.messageBytes);
  keys(value, ['protocol', 'requestID', 'bundleID', 'databasePath', 'status', 'nativeVersion', 'marker', 'sourceInventorySha256', 'verificationSha256']);
  if (value.protocol !== 'devryan-native-migration/1' || value.status !== 'completed' || value.nativeVersion !== '2.0.20' || !['completed', 'not-needed'].includes(value.marker)) throw invalid();
  string(value.requestID); string(value.bundleID); absolute(value.databasePath); digest(value.sourceInventorySha256); digest(value.verificationSha256);
  return structuredClone(value);
}

export function parseNativeAssetRequest(value) {
  bounded(value,NATIVE_PROCESS_LIMITS.messageBytes);
  keys(value,['protocol','type','globals','verificationRoot']);
  if(value.protocol!==1||value.type!=='verify-assets') throw invalid();
  absolute(value.verificationRoot);
  keys(value.globals,['home','config','data','state','cache','bin','log','repos','tmp']);
  for(const key of ['home','config','data','state','cache','bin','log','repos','tmp']) absolute(value.globals[key]);
  return structuredClone(value);
}
