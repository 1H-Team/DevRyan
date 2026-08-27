import React from 'react';
import { RiArchiveLine, RiRestartLine, RiSave3Line } from '@remixicon/react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import type { BotMemoryDetail, BotMemorySensitivity } from '@/lib/botsApi';

export type BotMemoryEditRequest = {
  text: string;
  sensitivity: BotMemorySensitivity;
  confidence: number;
  expectedUpdatedAt: string;
};

export const BotMemoryEditor: React.FC<{
  detail: BotMemoryDetail;
  busy?: boolean;
  onSave: (request: BotMemoryEditRequest) => void;
  onTombstone: () => void;
  onRestore: () => void;
}> = ({ detail, busy = false, onSave, onTombstone, onRestore }) => {
  const { memory } = detail;
  const [text, setText] = React.useState(memory.content.text);

  React.useEffect(() => setText(memory.content.text), [memory.content.text, memory.id]);

  const changed = text.trim().length > 0 && text.trim() !== memory.content.text;

  return (
    <section className="space-y-5" aria-labelledby="bot-memory-editor-heading">
      <div>
        <h4 id="bot-memory-editor-heading" className="typography-ui-header font-semibold text-foreground">
          {memory.logicalKey}
        </h4>
        <p className="mt-1 typography-micro text-muted-foreground">
          {memory.tombstonedAt
            ? 'Forgotten memories are retained here but excluded from future replies.'
            : 'Remembered memories may be used to personalize future replies.'}
        </p>
      </div>

      <label className="block space-y-1 typography-meta text-muted-foreground">
        <span>What the Bot Remembers</span>
        <Textarea rows={7} value={text} onChange={(event) => setText(event.target.value)} />
      </label>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          disabled={busy || !changed}
          onClick={() => onSave({
            text: text.trim(),
            sensitivity: memory.sensitivity,
            confidence: memory.confidence,
            expectedUpdatedAt: memory.updatedAt,
          })}
        >
          <RiSave3Line className="h-4 w-4" aria-hidden /> Save
        </Button>
        {memory.tombstonedAt ? (
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onRestore}>
            <RiRestartLine className="h-4 w-4" aria-hidden /> Remember Again
          </Button>
        ) : (
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onTombstone}>
            <RiArchiveLine className="h-4 w-4" aria-hidden /> Forget
          </Button>
        )}
      </div>
    </section>
  );
};
