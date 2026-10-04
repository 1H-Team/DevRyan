import express from 'express';
import {expect,it,vi} from 'vitest';
import request from '../../test-supertest.js';
import {registerOpenCodeRoutes} from './routes.js';
it('has no standalone OpenCode updater while verified bundle metadata remains readable',async()=>{
 const app=express();const check=vi.fn();
 registerOpenCodeRoutes(app,{cursorSessionTitleRuntime:{},standardSessionTitleRuntime:{},globalAgentsMdRuntime:{},openCodeClient:{generation:()=>2},
  readSettingsFromDiskMigrated:async()=>({}),getOpenCodeResolutionSnapshot:async()=>({source:'verified-native-bundle',targetVersion:'2.0.20',detectedVersion:null}),checkForOpenCodeUpdates:check});
 await request(app).get('/api/opencode/update-check').expect(404);
 await request(app).get('/api/config/opencode-resolution').expect(200).expect({source:'verified-native-bundle',targetVersion:'2.0.20',detectedVersion:null});expect(check).not.toHaveBeenCalled();
});
