import { Schema } from 'effect';
import { Permission } from '@opencode/core/permission';
import { Tool } from '@opencode/schema/tool';
import { Session } from '@opencode/schema/session';
import { SessionMessage } from '@opencode/schema/session-message';
import { Agent } from '@opencode/schema/agent';
import type { OperationPermit } from './native-admission-contract.js';

const WorkerFields = {
  protocol: Schema.Literal(1), input: Schema.Unknown,
  directory: Schema.String, projectDirectory: Schema.String, logicalDirectory: Schema.String,
  logicalProjectDirectory: Schema.String, scratchDirectory: Schema.String,
  config: Schema.Unknown,
  context: Schema.Struct({ sessionID: Session.ID, messageID: SessionMessage.ID, agent: Agent.ID, id: Tool.CallID }),
};
export const ReviewedBrowserAsset = Schema.Struct({binaryPath:Schema.String,sha256:Schema.String,configPath:Schema.String,configSha256:Schema.String,
  ffmpeg:Schema.optional(Schema.Struct({path:Schema.String,sha256:Schema.String}))});
export type ReviewedBrowserAsset=typeof ReviewedBrowserAsset.Type;
export const BrowserOperation = Schema.Struct({type:Schema.Literal('browser'),id:Schema.String,
  operation:Schema.Literals(['assert-current','resolve','acquire','touch','release']),
  scope:Schema.Struct({opencodeSessionID:Session.ID,messageID:SessionMessage.ID,directory:Schema.String,agent:Schema.NullOr(Schema.String)}),
  leaseID:Schema.optional(Schema.String)});
export type BrowserOperation=typeof BrowserOperation.Type;
export const BrowserReply=Schema.Union([
  Schema.Struct({type:Schema.Literal('browser'),id:Schema.String,ok:Schema.Literal(true),result:Schema.optional(Schema.Unknown)}),
  Schema.Struct({type:Schema.Literal('browser'),id:Schema.String,ok:Schema.Literal(false),error:Schema.String}),
]);
export type BrowserReply=typeof BrowserReply.Type;
export const ImageGenerationReply=Schema.Union([
 Schema.Struct({type:Schema.Literal('image-generation'),id:Schema.String,ok:Schema.Literal(true)}),
 Schema.Struct({type:Schema.Literal('image-generation'),id:Schema.String,ok:Schema.Literal(false),error:Schema.String}),
]);
export const WorkerInput = Schema.Union([
  Schema.Struct({...WorkerFields,tool: Schema.Literals(['write', 'edit', 'patch','gpt_imagegen'])}),
  Schema.Struct({...WorkerFields,tool:Schema.Literal('devryan_browser'),reviewedBrowser:ReviewedBrowserAsset,browserSocketDirectory:Schema.String,
    context:Schema.Struct({...WorkerFields.context.fields,userMessageID:SessionMessage.ID})}),
  Schema.Struct({...WorkerFields,tool: Schema.Literals(['ast_grep_search','ast_grep_replace']),
    reviewedAst:Schema.Struct({path:Schema.String,sha256:Schema.String})}),
]);
export type WorkerInput = typeof WorkerInput.Type;
const Metadata = Schema.Record(Schema.String, Schema.Unknown);
export const NativeResult = Schema.Struct({ output: Schema.optional(Schema.Unknown),
  content: Schema.optional(Schema.Union([Schema.String, Schema.Array(Tool.Content)])), metadata: Schema.optional(Metadata) });
export const WorkerError = Schema.Struct({ message: Schema.String, metadata: Schema.optional(Metadata), error: Schema.optional(Schema.Unknown) });
export const WorkerEvent = Schema.Union([
  BrowserOperation,
  Schema.Struct({type:Schema.Literal('image-generation'),id:Schema.String}),
  Schema.Struct({ type: Schema.Literal('permission'), id: Schema.String, input: Permission.AssertInput }),
  Schema.Struct({ type: Schema.Literal('progress'), update: Metadata }),
  Schema.Struct({ type: Schema.Literal('result'), ok: Schema.Literal(true), result: NativeResult }),
  Schema.Struct({ type: Schema.Literal('result'), ok: Schema.Literal(false), error: WorkerError }),
]);
export type WorkerEvent = typeof WorkerEvent.Type;
export const PermissionReply = Schema.Struct({ id: Schema.String, ok: Schema.Boolean, error: Schema.optional(Schema.Unknown) });
export type PermissionReply = typeof PermissionReply.Type;
export const TerminationReceipt = Schema.Struct({ terminated: Schema.Literal(true), confined: Schema.Boolean,
  cancelled: Schema.Boolean, exitCode: Schema.Int });
export const ExecutionEvent = Schema.Union([
  Schema.Struct({ cursor: Schema.Int, type: Schema.Literal('started'), pid: Schema.Int }),
  Schema.Struct({ cursor: Schema.Int, type: Schema.Literal('output'), stream: Schema.Literals(['stdout', 'stderr']), data: Schema.String }),
  Schema.Struct({ cursor: Schema.Int, type: Schema.Literal('permission'), id: Schema.String, input: Permission.AssertInput }),
  Schema.Struct({ cursor: Schema.Int, type: Schema.Literal('progress'), update: Metadata }),
  Schema.Struct({ cursor: Schema.Int, type: Schema.Literal('settled'), ok: Schema.Boolean,
    receipt: Schema.optional(TerminationReceipt), result: Schema.optional(NativeResult), error: Schema.optional(WorkerError) }),
  Schema.Struct({ cursor: Schema.Int, type: Schema.Literal('uncertain'), error: Schema.Struct({ code: Schema.String }) }),
]);
export type ExecutionEvent = typeof ExecutionEvent.Type;
export const ExecutionBatch = Schema.Struct({ cursor: Schema.Int, done: Schema.Boolean, events: Schema.Array(ExecutionEvent) });
export const StartResult = Schema.Struct({ handle: Schema.String });
export interface ExecutionIdentity {
  readonly directory: string; readonly sessionID: string; readonly messageID: string;
  readonly callID: string; readonly tool: string; readonly agent: string; readonly permit: OperationPermit;
}
export interface WriterSpecification { readonly kind: 'writer'; readonly tool: string; readonly input: unknown }
export interface ShellSpecification { readonly kind: 'shell' | 'read'; readonly command: string; readonly args: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>; readonly cwd?: string }
export type ExecutionSpecification = WriterSpecification | ShellSpecification;
export type ExecutionRpc = (method: string, params: Readonly<Record<string, unknown>>, options?: { readonly signal?: AbortSignal }) => Promise<unknown>;
