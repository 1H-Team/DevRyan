import {describe,expect,test} from 'bun:test'
import {createIntegrationUIEvents,IMAGES_SKIPPED_MESSAGE} from './integration-ui-events'
const id='12345678-1234-1234-1234-123456789abc'
const route='/api/openchamber/interviews/'+ 'a'.repeat(64)+'/interview/interview_1'
const event=(kind='interview-open',properties:Record<string,unknown>={})=>({type:'openchamber:integration',properties:{directory:'/repo',sessionID:'ses_one',eventID:id,kind,...(kind==='interview-open'?{path:route}:{}),...properties}})
function fixture(panel=true){
 const opened:string[][]=[],external:string[]=[],notices:string[]=[],blocked:Array<()=>void>=[]
 let authorized=true,allowPopup=false
 const owner=createIntegrationUIEvents({origin:()=> 'https://devryan.test',canOpenBrowser:()=>authorized,supportsBrowserPanel:()=>panel,
 openBrowserPanel:(directory,url)=>{opened.push([directory,url])},openExternal:async url=>{external.push(url);return allowPopup},
 imagesSkipped:eventID=>{notices.push(eventID)},openBlocked:(_eventID,retry)=>{blocked.push(retry)}})
 return {owner,opened,external,notices,blocked,revoke:()=>{authorized=false},allowPopup:()=>{allowPopup=true}}
}
describe('authenticated integration UI effects',()=>{
 test('opens exact same-origin interview in shared browser panel and deduplicates replay',()=>{
  const f=fixture();expect(f.owner.handle('/repo',event())).toBe(true);expect(f.owner.handle('/repo',event())).toBe(true)
  expect(f.opened).toEqual([['/repo','https://devryan.test'+route]])
  f.owner.releaseDirectory('/repo');f.owner.handle('/repo',event());expect(f.opened).toHaveLength(2)
 })
 test('refuses foreign/encoded/query/credential routes, forged directory, IDs and extra fields',()=>{
  const f=fixture()
  for(const path of ['https://evil.test'+route,'//evil.test'+route,route+'?url=https://evil.test',route+'#x',route+'/%2e%2e',route.replace('interview_1','..'),'/api/openchamber/interviews/short/interview/id'])expect(f.owner.handle('/repo',event('interview-open',{path}))).toBe(false)
  for(const p of [{directory:'/other'},{eventID:'arbitrary'},{sessionID:'../session'},{kind:'execute'},{url:'https://evil.test'}])expect(f.owner.handle('/repo',event('interview-open',p))).toBe(false)
  expect(f.opened).toHaveLength(0)
 })
 test('fixed original warning accepts no caller-provided text and retains original message',()=>{
  const f=fixture();expect(f.owner.handle('/repo',event('images-skipped'))).toBe(true);f.owner.handle('/repo',event('images-skipped'))
  expect(f.notices).toEqual([id]);expect(f.owner.handle('/repo',event('images-skipped',{message:'Injected'}))).toBe(false)
  expect(IMAGES_SKIPPED_MESSAGE).toBe('Observer agent is disabled, so images can\'t be analyzed. Set image_routing to "direct" to send images to your model, or enable observer.')
 })
 test('popup-blocked fallback offers explicit retry and respects current browser permission',async()=>{
  const f=fixture(false);f.owner.handle('/repo',event());await Promise.resolve();await Promise.resolve()
  expect(f.external).toEqual(['https://devryan.test'+route]);expect(f.blocked).toHaveLength(1)
  f.allowPopup();f.blocked[0]();await Promise.resolve();expect(f.external).toHaveLength(2)
  f.revoke();f.blocked[0]();await Promise.resolve();expect(f.external).toHaveLength(2)
 })
 test('teardown refuses late effects, and replay cache has a finite 512-event bound',async()=>{
  const f=fixture(false);f.owner.handle('/repo',event());f.owner.dispose();await Promise.resolve();await Promise.resolve()
  expect(f.blocked).toHaveLength(0);expect(f.owner.handle('/repo',event('images-skipped'))).toBe(false)
  const g=fixture();for(let n=0;n<513;n++)g.owner.handle('/repo',event('images-skipped',{eventID:'12345678-1234-1234-1234-'+n.toString(16).padStart(12,'0')}))
  g.owner.handle('/repo',event('images-skipped',{eventID:'12345678-1234-1234-1234-000000000000'}));expect(g.notices).toHaveLength(514)
 })
})
