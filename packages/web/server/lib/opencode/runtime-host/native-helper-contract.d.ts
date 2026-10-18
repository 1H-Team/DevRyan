export interface NativeHelperInput {
 readonly operationID?:string;
 readonly directory:string;readonly sessionID?:string;readonly agent:'devryan-title'|'devryan-commit'|'devryan-pr'|'devryan-notify';
 readonly providerID:string;readonly modelID:string;readonly variant?:string;readonly selectionMode?:'configured'|'active';readonly selectionRevision?:string;readonly prompt:string;readonly system?:string;
 readonly timeoutMs?:number;readonly maxOutputTokens?:number;
}
export function nativeHelperInput(input:unknown):Readonly<NativeHelperInput>&{readonly timeoutMs:number;readonly maxOutputTokens:number};
export interface NativeHelperTitleInput {readonly operationID?:string;readonly directory:string;readonly sessionID:string;readonly title:string;readonly expectedTitle:string;readonly sourceMessageID?:string}
export function nativeHelperTitleInput(input:unknown):Readonly<NativeHelperTitleInput>;
