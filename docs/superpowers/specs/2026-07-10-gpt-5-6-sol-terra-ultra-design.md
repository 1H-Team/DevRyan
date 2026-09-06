# GPT-5.6 Sol, Terra, and Luna Native Reasoning Capabilities

## Goal

Expose Max and Ultra as distinct native reasoning levels in DevRyan. GPT-5.6 Sol and Terra support both Max and Ultra; GPT-5.6 Luna supports Max only. Extra High remains independent, and the existing Fast toggle must preserve the selected reasoning level.

## Capability Matrix

| Family | Base | Fast | Pro |
| --- | --- | --- | --- |
| GPT-5.6 Sol | Extra High, Max, Ultra | Extra High, Max, Ultra | Provider metadata only |
| GPT-5.6 Terra | Extra High, Max, Ultra | Extra High, Max, Ultra | Provider metadata only |
| GPT-5.6 Luna | Extra High, Max | Extra High, Max | Provider metadata only |

Direct OpenAI capability corrections apply to these exact IDs:

- Max: `gpt-5.6-sol`, `gpt-5.6-sol-fast`, `gpt-5.6-terra`, `gpt-5.6-terra-fast`, `gpt-5.6-luna`, and `gpt-5.6-luna-fast`.
- Ultra: `gpt-5.6-sol`, `gpt-5.6-sol-fast`, `gpt-5.6-terra`, and `gpt-5.6-terra-fast`.

No Pro ID is inferred or patched. Anthropic and unrelated providers keep their discovered Max behavior.

## Design

### Direct OpenAI

Managed OpenCode runtime overlays advertise literal `max` and `ultra` variants with matching `reasoningEffort` wire values. The records retain the standard reasoning summary and encrypted reasoning-content options used by adjacent OpenAI variants.

This is a compatibility correction for incomplete upstream metadata, not a user-defined model mode. DevRyan does not modify source user configuration. Web/Electron generate the same capability records.

### Cursor SDK

Cursor discovery preserves every SDK-advertised `max` variant as Max. For the exact SDK model IDs `gpt-5.6-sol` and `gpt-5.6-terra`, DevRyan also adds the known native Ultra selection when the SDK catalog omits it.

The added selection copies the discovered model context and Fast parameters but sends the literal reasoning value `ultra`. Therefore Max sends `max`, Ultra sends `ultra`, Fast retains `fast: true`, and base retains `fast: false`.

Luna and Anthropic keep Max without receiving Ultra. Existing literal SDK Ultra entries win and are never overwritten.

### Shared UI and Send Flow

The shared UI remains capability-driven. It orders known levels as `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`, followed by arbitrary provider variants.

Labels and wire values remain distinct:

- `xhigh` / `extra-high` → Extra High
- `max` → Max
- `ultra` → Ultra

The selected raw string is preserved through keyboard cycling, agent defaults, draft/session restoration, queued sends, model switching, and message submission. Fast changes only the execution dimension.

## Failure Handling

- Existing provider fields and variants are deep-merged.
- Literal provider Ultra metadata is not duplicated or replaced.
- Unsupported models never receive Ultra.
- Pro and unrelated model families are not inferred from names.
- A rehydrated draft variant is retained while its draft agent restores.

## Testing and Verification

- Cursor discovery tests prove Sol/Terra expose separate Max and Ultra wire selections, Luna exposes Max only, and Fast retains each level.
- Web overlay tests prove the exact capability matrix.
- Shared UI/send tests prove ordering, labels, raw wire fidelity, defaults, restoration, cycling, queues, and sends.
- Electron packaging tests ensure Cursor SDK's `sqlite3` binding is rebuilt and shipped.
- The installed app is queried for live provider metadata and visually checked at desktop and compact widths with console-error and clipping checks.
