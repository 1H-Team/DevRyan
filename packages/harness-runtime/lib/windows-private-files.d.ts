export interface WindowsFileIdentity {
  protocol: 'devryan.windows-file-identity/1'; volume: string; fileId: string;
  type: 'file' | 'directory'; reparsePoint: boolean; linkCount: number; currentOwner: boolean; privateAcl: boolean;
}
export interface WindowsPrivateRead { identity: WindowsFileIdentity; bytes: Buffer }
export interface WindowsPrivatePublication {
  protocol: 'devryan.windows-private-publication/1'; status: 'published'; nonce: string;
  parentVolume: string; parentFileId: string; volume: string; fileId: string;
  size: number; sha256: string; namespaceFlushed: true;
}
export interface WindowsPrivateDeletion {
  protocol: 'devryan.windows-private-deletion/1'; status: 'deleted'; nonce: string;
  parentVolume: string; parentFileId: string; oldToken: string | null; namespaceFlushed: true;
}
export interface WindowsLargePrivateFile { protocol: 'devryan.windows-update-file/1'; token: string; size: number }
export interface WindowsPublicationPruning { protocol: 'devryan.windows-publication-pruning/1'; retained: number; pruned: number; namespaceFlushed: true }
export interface WindowsPrivateTreeCopy { protocol:'devryan.windows-private-tree-copy/1';sourceToken:string;destinationToken:string;sourceParentVolume:string;sourceParentFileId:string;destinationParentVolume:string;destinationParentFileId:string;namespaceFlushed:true;exclusions:'none'|'runtime-bundle' }
export interface WindowsSqliteOutput {ready:Promise<void>;assertHeld():void;commit():Promise<WindowsLargePrivateFile>;cancel():Promise<WindowsLargePrivateFile|null>}
export interface WindowsNativeImportReceipt {protocol:'devryan.windows-native-import/1';nonce:string;operation:'migrate'|'relocate-bundle-harness';rootExclusions:'none'|'runtime-bundle';mutating:boolean;controllerToken:string;gitToken:string|null;rootToken:string;environmentToken:string|null;namespaceFlushed:true;jobSettled:true;exitCode:0}
export interface WindowsNativeImport {ready:Promise<void>;assertHeld():void;writeRequest(bytes:Buffer):Promise<void>;finish():Promise<{receipt:WindowsNativeImportReceipt;stdout:Buffer;stderr:Buffer}>;cancel():Promise<unknown|null>}
export interface WindowsNativeImportOptions {controller:string;controllerSha256:string;expectedArtifactToken:string;root:string;expectedRootToken:string;nativeReceipt:string;nonce:string;operation?:'migrate'|'relocate-bundle-harness';rootExclusions?:'none'|'runtime-bundle';mutating?:boolean;environmentRoot?:string}
export interface WindowsPrivateFileOwner {
  readonly launcher: string;
  readonly maxBytes: number;
  read(file: string): Promise<WindowsPrivateRead>;
  write(file: string, bytes: Buffer, options?: { expected?: WindowsPrivateRead | null }): Promise<WindowsPrivatePublication>;
  recover(file: string): Promise<WindowsPrivatePublication | WindowsPrivateDeletion | null>;
  delete(file: string, options?: { expected?: WindowsPrivateRead | null }): Promise<WindowsPrivateDeletion & { backupPath: string | null }>;
  quarantine(file: string, previous: WindowsPrivateRead): Promise<string>;
  ensureDirectory(directory: string): Promise<WindowsFileIdentity>;
  createDirectory(directory:string):Promise<WindowsFileIdentity>;
  copyTree(source:string,destination:string,expectedToken:string,options?:{exclusions?:'none'|'runtime-bundle'}):Promise<WindowsPrivateTreeCopy>;
  beginSqliteOutput(root:string,basename:string):WindowsSqliteOutput;
  beginNativeImport(options:WindowsNativeImportOptions):WindowsNativeImport;
  tree(target: string, options?:{exclusions:'none'|'runtime-bundle'}): Promise<string>;
  cloneTree(source: string, destination: string, expectedToken: string): Promise<string>;
  renameTree(source: string, destination: string, expectedToken: string): Promise<string>;
  removeTree(target: string, expectedToken: string): Promise<string>;
  largeFile(target: string): Promise<WindowsLargePrivateFile>;
  streamFile(source: string, target: string, options: { expectedSha256: string; expectedSize: number }): Promise<WindowsLargePrivateFile>;
  append(target: string, bytes: Buffer, options: { expected: string; offset: number; maximum: number }): Promise<WindowsLargePrivateFile>;
  renameFile(source: string, destination: string, expectedToken: string): Promise<WindowsLargePrivateFile>;
  truncate(target: string, length: number, expectedToken: string): Promise<WindowsLargePrivateFile>;
  prune(file: string): Promise<WindowsPublicationPruning>;
}
export function createWindowsPrivateFileOwner(options: { launcher: string; retainedPublications?: number; maxBytes?: number }): WindowsPrivateFileOwner;
export function parseWindowsFileIdentity(raw: string): WindowsFileIdentity;
export function parseWindowsPrivateFileRead(raw: Buffer, maximum?: number): WindowsPrivateRead;
export function parseWindowsPrivatePublication(raw: string, maximum?: number): WindowsPrivatePublication;
export function parseWindowsPrivateDeletion(raw: string, maximum?: number): WindowsPrivateDeletion;
export function parseWindowsPrivateTree(raw: string, namespaceFlushed: boolean): string;
export function parseWindowsPrivateTreeCopy(raw:string):WindowsPrivateTreeCopy;
export function isWindowsPrivateControlName(name:unknown):boolean;
export function parseWindowsNativeImportReceipt(raw:string):WindowsNativeImportReceipt;
export function parseWindowsNativeImportFrame(raw:Buffer):{receipt:WindowsNativeImportReceipt;stdout:Buffer;stderr:Buffer};
export function parseWindowsLargePrivateFile(raw: string): WindowsLargePrivateFile;
export function parseWindowsPublicationPruning(raw: string): WindowsPublicationPruning;
export function parseWindowsPublicationState(raw: string): { protocol: 'devryan.windows-publication-state/1'; status: 'none' | 'pending' | 'published' | 'deleted'; nonce: string | null };
export function parseWindowsNamespaceDurability(raw: string): { protocol: 'devryan.windows-namespace-durability/1'; volume: string; fileId: string; directoryFlushed: boolean; windowsError: number; publicationQualified: false };
export function ensureWindowsPrivateDirectory(launcher: string, directory: string): Promise<WindowsFileIdentity>;
export function createWindowsPrivateFile(launcher: string, file: string, bytes: Buffer): Promise<WindowsFileIdentity>;
export function readWindowsPrivateFile(launcher: string, file: string): Promise<WindowsPrivateRead>;
export function inspectWindowsNamespaceDurability(launcher: string, file: string): ReturnType<typeof parseWindowsNamespaceDurability> extends infer Receipt ? Promise<Receipt> : never;
export function windowsPublicationExpected(previous: WindowsPrivateRead | null, maximum?: number): string;
