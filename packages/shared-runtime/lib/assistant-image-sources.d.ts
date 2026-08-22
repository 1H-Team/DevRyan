export type AssistantImageReferenceKind = 'markdown-image' | 'markdown-link' | 'reference-image';

export interface AssistantImageReference {
  source: string;
  caption: string;
  kind: AssistantImageReferenceKind;
  start: number;
  end: number;
}

export function canonicalizeAssistantImageSource(value: unknown): string | null;
export function isSupportedAssistantImageSource(value: unknown): boolean;
export function extractAssistantImageReferences(markdown: string): AssistantImageReference[];
export function stripAssistantImageMarkdown(markdown: string): string;
export const SUPPORTED_IMAGE_EXTENSIONS: Set<string>;
