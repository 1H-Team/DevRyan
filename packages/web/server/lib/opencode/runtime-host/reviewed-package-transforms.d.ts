export const SLIM_SERVER_SOURCE_SHA256: string;
export const REVIEWED_AST_ASSET_SHA256: string;
export interface ReviewedPackageTransform {readonly id:string;readonly originalSHA256:string;readonly outputSHA256:string}
export function rewriteReviewedSlimServer(source:Uint8Array|string):{readonly contents:string;readonly sourceSHA256:string;readonly outputSHA256:string;readonly transforms:readonly ReviewedPackageTransform[]};
