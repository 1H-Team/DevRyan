import type {resolveSlimAgents,slimCommandDeclarations,createReviewedDocumentCache,interviewCommandDeclaration} from './reviewed-configuration-entry.js';
export interface NativeReviewedConfiguration {
 readonly reviewedImagegenOriginals:Pick<import("./native-imagegen.js").NativeImagegenOriginals,"withReviewedImagegenOwner"|"callReviewedImagegenResponses">;
 readonly reviewedSlimInterviewOriginals:import('./native-interview-owner.js').NativeInterviewOriginals;
 readonly createReviewedSlimTaskBoardRenderer:typeof import('./reviewed-configuration-entry.js').createReviewedSlimTaskBoardRenderer;
 readonly formatReviewedSlimTaskBoard:typeof import('./reviewed-configuration-entry.js').formatReviewedSlimTaskBoard;
 readonly isReviewedSlimFailoverError:typeof import('./reviewed-configuration-entry.js').isReviewedSlimFailoverError;
 readonly selectReviewedSlimFallback:typeof import('./reviewed-configuration-entry.js').selectReviewedSlimFallback;
 readonly createOwnedNativeDocument:typeof import('./native-document.js').createOwnedNativeDocument;
 readonly reviewedDocumentOriginals:import('./native-document.js').NativeDocumentOriginals;
 readonly createReviewedDocumentCache:typeof createReviewedDocumentCache;
 readonly resolveSlimAgents:typeof resolveSlimAgents;
 readonly interviewCommandDeclaration:typeof interviewCommandDeclaration;
 readonly slimCommandDeclarations:typeof slimCommandDeclarations;
}
export function loadNativeReviewedConfiguration(artifacts:{readonly reviewedConfiguration?:{readonly path:string;readonly size:number;readonly sha256:string};readonly manifest:{readonly buildId:string}}):Promise<NativeReviewedConfiguration|undefined>;
