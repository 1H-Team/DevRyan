import fs from 'node:fs/promises';import path from 'node:path';import {createHash}from'node:crypto';
import {verifyNativeRuntimeArtifacts}from'../../packages/web/server/lib/opencode/runtime-host/native-artifacts.js';
import {runCompiledAssetAcceptance}from'./compiled-process.mjs';import {repositoryRoot}from'./artifacts.mjs';
const args=process.argv.slice(2);if(args.length!==1)throw new Error('Expected one repo-owned artifact directory');
const dir=await fs.realpath(path.resolve(args[0]));if(!dir.startsWith(repositoryRoot+path.sep))throw new Error('Artifact outside repo');
const manifestPath=path.join(dir,'native-bundle.json');const manifestSha256=createHash('sha256').update(await fs.readFile(manifestPath)).digest('hex');
const artifacts=await verifyNativeRuntimeArtifacts({manifestPath,manifestSha256,launcher:path.join(dir,'DevRyan-execution-darwin-arm64')});
const root=await fs.realpath(await fs.mkdtemp(path.join(repositoryRoot,'.cache/v2-validation/asset-diag-')));
try{process.stdout.write(JSON.stringify({root,...await runCompiledAssetAcceptance({artifacts,root})})+'\n');}
catch(error){process.stdout.write(JSON.stringify({root,code:error.code,message:error.message,evidence:error.protocolEvidence})+'\n');process.exitCode=1;}
