import type {WindowsPrivateFileOwner} from '../../../../../harness-runtime/lib/windows-private-files.js';
export interface ClaudeProfileFilesBaseline {
 readonly profilesSha256:string|null;
 readonly settingsSha256:string|null;
 readonly selectedProfileID:string|null;
}
export interface ClaudeEnrollmentProfile {
 readonly id:string;
 readonly type:'claude-max';
 readonly claudeConfigDir:string;
 readonly keychainService:string;
}
export function createNativeClaudeProfilePublication(options:{readonly home:string;readonly controlRoot:string;readonly windowsOwner?:WindowsPrivateFileOwner;readonly windowsLauncher?:string}):{
 snapshot():Promise<ClaudeProfileFilesBaseline>;
 publish(profile:ClaudeEnrollmentProfile,expected:ClaudeProfileFilesBaseline,context:{readonly recheck:()=>Promise<void>}):Promise<void>;
};
