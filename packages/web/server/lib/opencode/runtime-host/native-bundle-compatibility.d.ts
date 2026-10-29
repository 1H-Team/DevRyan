export interface NativeCloneLayout {
 readonly structureSha256:string;
 readonly migrationsSha256:string|null;
 readonly userVersion:number;
}
export interface NativeCloneManifest {
 readonly opencodeVersion:string;
 readonly inputs:{readonly coreDigest:string};
 readonly compiledContracts:readonly string[];
}
export const REVIEWED_NATIVE_CLONE_RELEASES:Readonly<Record<string,string>>;
export const REVIEWED_NATIVE_PROJECT_ARCHIVE_FRESH_CLONE_LAYOUT:Readonly<NativeCloneLayout>;
export const REVIEWED_NATIVE_BLOB_STORE_FRESH_CLONE_LAYOUT:Readonly<NativeCloneLayout>;
export const REVIEWED_NATIVE_SCHEDULE_FRESH_CLONE_LAYOUT:Readonly<NativeCloneLayout>;
export const REVIEWED_NATIVE_SESSION_PART_FRESH_CLONE_LAYOUT:Readonly<NativeCloneLayout>;
export function inspectNativeCloneLayout(databasePath:string):NativeCloneLayout;
export function verifyNativeCloneCompatibility(options:{left:NativeCloneManifest;right:NativeCloneManifest;databasePath:string}):void;
