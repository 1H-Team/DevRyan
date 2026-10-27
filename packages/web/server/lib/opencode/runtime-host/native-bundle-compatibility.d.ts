export interface NativeCloneLayout {
 readonly structureSha256:string;
 readonly migrationsSha256:string|null;
 readonly userVersion:number;
}
export const REVIEWED_NATIVE_PROJECT_ARCHIVE_FRESH_CLONE_LAYOUT:Readonly<NativeCloneLayout>;
export const REVIEWED_NATIVE_BLOB_STORE_FRESH_CLONE_LAYOUT:Readonly<NativeCloneLayout>;
export function inspectNativeCloneLayout(databasePath:string):NativeCloneLayout;
