// DevRyan: interview document I/O is performed by the host's confined
// interview owner. Its operations mirror the original document functions in
// ./document.ts (which the confined worker runs), so the service keeps the
// exact original algorithms while authority stays with the owner.
import type { InterviewAnswer, InterviewQuestion, InterviewRecord } from './types';

export interface InterviewDocuments {
  withLock<T>(markdownPath: string, operation: () => Promise<T>): Promise<T>;
  ensure(record: InterviewRecord): Promise<void>;
  claim(markdownPath: string, sessionID: string, baseMessageCount: number): Promise<string>;
  read(record: InterviewRecord): Promise<string>;
  /** May reject with InterviewPatchApplyError / InterviewPatchRequiredError. */
  rewrite(
    record: InterviewRecord,
    summary: string,
    title?: string,
    patch?: string,
    consumedState?: string,
  ): Promise<string>;
  rewriteFinal(record: InterviewRecord, finalMarkdown: string): Promise<string>;
  markComplete(record: InterviewRecord): Promise<string>;
  markIncomplete(record: InterviewRecord): Promise<string>;
  appendAnswers(record: InterviewRecord, questions: InterviewQuestion[], answers: InterviewAnswer[]): Promise<void>;
  readText(file: string, encoding: 'utf8'): Promise<string>;
  list(directory: string): Promise<string[]>;
  stat(file: string): Promise<{ readonly mtimeMs: number }>;
  resolveExisting(directory: string, outputFolder: string, value: string): Promise<string | null>;
}
