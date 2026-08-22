export interface AssistantImageSyntaxFixture {
  name: string;
  markdown: string;
  expected: Array<{
    source: string;
    caption: string;
    kind: 'markdown-image' | 'markdown-link' | 'reference-image';
  }>;
}

export const assistantImageSyntaxFixtures: AssistantImageSyntaxFixture[];
