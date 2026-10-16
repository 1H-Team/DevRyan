export * from '../../../../../shared-runtime/lib/native-observation.js';

/** Constructor-private proof of post-model mandatory native I/O; never execution authority. */
export interface NativePresentation {
 readonly schema:1;readonly controllerInstanceID:string;readonly configurationDigest:string;
 readonly sessionID:string;readonly directory:string;readonly requestID:string;readonly assistantMessageID:string;readonly stepID:string;
 readonly attempt:{readonly traceID:string;readonly spanID:string};readonly phase:'finalizing'|'cleared';readonly progress:number;readonly sequence:number;
}
export function parseNativePresentation(value:unknown):NativePresentation;
export interface NativePresentationProgress {
 readonly provider:'native';readonly ownerID:string;readonly sessionID:string;readonly generation:string;readonly sequence:number;
 readonly objectiveID:string;readonly assistantID:string;readonly stepID:string;readonly attemptID:string;
 readonly phase:'finalizing'|'cleared';readonly progress:number;
}
