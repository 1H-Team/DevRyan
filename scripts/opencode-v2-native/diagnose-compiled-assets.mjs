import fs from 'node:fs/promises';import path from 'node:path';import {createHash}from'node:crypto';
import {verifyNativeRuntimeArtifacts}from'../../packages/web/server/lib/opencode/runtime-host/native-artifacts.js';
import {createRunRoot}from'../qa/run-root.mjs';import {runCompiledAssetAcceptance}from'./compiled-process.mjs';import {repositoryRoot}from'./artifacts.mjs';
const args=process.argv.slice(2);if(args.length!==1)throw new Error('Expected one repo-owned artifact directory');
const dir=await fs.realpath(path.resolve(args[0]));if(!dir.startsWith(repositoryRoot+path.sep))throw new Error('Artifact outside repo');
const manifestPath=path.join(dir,'native-bundle.json');const manifestSha256=createHash('sha256').update(await fs.readFile(manifestPath)).digest('hex');
const artifacts=await verifyNativeRuntimeArtifacts({manifestPath,manifestSha256,launcher:path.join(dir,'DevRyan-execution-darwin-arm64')});
const run=createRunRoot({parent:path.join(repositoryRoot,'.cache/v2-validation'),prefix:'asset-diag-',owner:'scripts/opencode-v2-native/diagnose-compiled-assets.mjs'});
const root=await fs.realpath(run.dir);
try{process.stdout.write(JSON.stringify({root,...await runCompiledAssetAcceptance({artifacts,root})})+'\n');run.finish('passed');}
catch(error){process.stdout.write(JSON.stringify({root,code:error.code,message:error.message,evidence:error.protocolEvidence})+'\n');process.exitCode=1;run.finish('failed');}
