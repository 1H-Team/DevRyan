import { test, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { executionArtifactDirectory, executionArtifacts, verifyExecutionArtifacts } from './execution-artifacts.js';

test('packaged Electron uses resources when its development flag is explicitly disabled', () => {
  const resourcesPath = path.resolve('/fixture/DevRyan.app/Contents/Resources');
  for (const developmentMode of ['0', 'false', '']) {
    expect(executionArtifactDirectory({ resourcesPath, developmentMode }))
      .toBe(path.join(resourcesPath, 'revert-runtime', `${process.platform}-${process.arch}`));
  }
  expect(executionArtifactDirectory({ resourcesPath, developmentMode: '1' }))
    .not.toContain(resourcesPath);
});

test('supervisor acceptance is required independently of native bundle verification',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'execution-artifacts-')),artifacts=executionArtifacts(directory),sha256=createHash('sha256').update('fixture').digest('hex');
 try{
  expect(artifacts.opencode).toBeUndefined();await expect(verifyExecutionArtifacts({directory})).rejects.toMatchObject({code:'execution_artifacts_unavailable'});
  await fs.writeFile(artifacts.launcher,'fixture');await fs.writeFile(artifacts.launcher+'-spawn.dylib','fixture');
  const manifest={version:1,policy:2,acceptance:true,platform:process.platform,arch:process.arch,binary:path.basename(artifacts.launcher),sha256,spawnLibrary:path.basename(artifacts.launcher)+'-spawn.dylib',spawnSha256:sha256};
  await fs.writeFile(artifacts.launcher+'.json',JSON.stringify(manifest));expect(await verifyExecutionArtifacts({directory})).toEqual(artifacts);
  await fs.writeFile(artifacts.launcher+'.json',JSON.stringify({...manifest,acceptance:false}));await expect(verifyExecutionArtifacts({directory})).rejects.toMatchObject({code:'execution_artifacts_unavailable'});
 }finally{await fs.rm(directory,{recursive:true,force:true});}
});
