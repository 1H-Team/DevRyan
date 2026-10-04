import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const expected={builder:'23c050103f28dbe6bad953ae21d98cd06d720a20f33d4716e9de419f947d495e',skill:'1316a2f3f95741d2300b116fe0c2d81ce4a9568656ed0a62643f54aaf09957f2',parser:'36073b0749a62bebadb22c01b7fc018d063fb20b337591269008051151a1513d',command:'800919b5c7b53f05e9adb96e5978818f3b5cd9137bc2df35b1575590d5464f14'};
/** Build-only: run the exact reviewed shared builder, never its ambient plugin. */
export async function renderReviewedPonytailInstructions(){
 const root=new URL('../../../../runtime/reviewed-inputs/ponytail-4.10.0/',import.meta.url);
 const builderPath=fileURLToPath(new URL('hooks/ponytail-instructions.js',root));
 const skillPath=fileURLToPath(new URL('skills/ponytail/SKILL.md',root));
 const [builderBytes,skillBytes,commandBytes]=await Promise.all([fs.readFile(builderPath),fs.readFile(skillPath),fs.readFile(new URL('.opencode/command/ponytail.md',root))]);
 if(hash(builderBytes)!==expected.builder||hash(skillBytes)!==expected.skill||hash(commandBytes)!==expected.command)throw new Error('reviewed_ponytail_source_changed');
 const builder=createRequire(import.meta.url)(builderPath),skill=skillBytes.toString('utf8'),instructions={};
 for(const mode of ['lite','full','ultra','review']){
  const content=builder.getPonytailInstructions(mode);
  const exact=mode==='review'?'PONYTAIL MODE ACTIVE — level: review. Behavior defined by /ponytail-review skill.':`PONYTAIL MODE ACTIVE — level: ${mode}\n\n`+builder.filterSkillBodyForMode(skill,mode);
  if(content!==exact)throw new Error('reviewed_ponytail_builder_mismatch');
  instructions[mode]=content;
 }
 const parserPath=fileURLToPath(new URL('.opencode/plugins/ponytail-frontmatter.cjs',root));
 if(hash(await fs.readFile(parserPath))!==expected.parser)throw new Error('reviewed_ponytail_source_changed');
 const {parseCommandFile}=createRequire(import.meta.url)(parserPath),commands={},commandHashes={
 'ponytail':'800919b5c7b53f05e9adb96e5978818f3b5cd9137bc2df35b1575590d5464f14',
 'ponytail-audit':'6278f820b117a6a57e4c0b013906e06fe4719652e6adc4b9a1b868d6bd1ba6f2',
 'ponytail-debt':'ddbadb1f484a1ecc54ed577b80aa3f7b326ccd1ae2a35159652a52221eb31301',
 'ponytail-gain':'33514a67319e30072e1daeef336b4f4af8de31ef25595a23353f0719004189b2',
 'ponytail-help':'3052afd5cc1ea528d9405729b2620d1b81c36ca3287ec1ae964a68d6feb4c178',
 'ponytail-review':'ff09bd42b1d23bd3e3919c6b7ab4710c0a71b04e23c0fc30fb3c1b1b50451485'};
 for(const [name,sha] of Object.entries(commandHashes)){
  const file=fileURLToPath(new URL(`.opencode/command/${name}.md`,root));
  if(hash(await fs.readFile(file))!==sha)throw new Error('reviewed_ponytail_source_changed');
  const declaration=parseCommandFile(file);if(!declaration||typeof declaration.description!=='string'||typeof declaration.template!=='string')throw new Error('reviewed_ponytail_command_changed');
  commands[name]=Object.freeze(declaration);
 }
 const command=commands.ponytail,sourceSHA256={...expected,commands:commandHashes};
 return {instructions,command,commands,sourceSHA256,outputSHA256:hash(JSON.stringify(instructions)),moduleSource:`export default ${JSON.stringify(instructions)};\nexport const commands=${JSON.stringify(commands)};\nexport const command=commands.ponytail;\n`};
}
