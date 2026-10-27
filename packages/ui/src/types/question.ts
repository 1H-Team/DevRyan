export interface QuestionOption {
  label: string;
  description: string;
}

/** Typed input hints a form field declares (OpenCode 2.1.4 form schema). */
export type QuestionInputKind = 'text' | 'number' | 'integer' | 'email' | 'uri' | 'date' | 'date-time';

export interface QuestionInputHint {
  kind: QuestionInputKind;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  placeholder?: string;
  default?: string | number;
}

/** An http(s) page the user completes outside DevRyan; never opened automatically. */
export interface QuestionExternalLink {
  url: string;
  title?: string;
}

export interface QuestionInfo {
  question: string;
  header: string;
  options: QuestionOption[];
  multiple?: boolean;
  custom?: boolean;
  input?: QuestionInputHint;
  /** Present on forms other than the question tool's; `false` allows an empty answer. */
  required?: boolean;
  minItems?: number;
  maxItems?: number;
  external?: QuestionExternalLink;
}

/** Who asked: an MCP server's input request rather than the agent. */
export interface QuestionSource {
  type: 'mcp-elicitation';
  server: string;
  message: string;
}

export interface QuestionRequest {
  id: string;
  sessionID: string;
  questions: QuestionInfo[];
  tool?: {
    messageID: string;
    callID: string;
  };
  source?: QuestionSource;
}
