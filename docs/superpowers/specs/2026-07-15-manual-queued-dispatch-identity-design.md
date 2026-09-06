# Manual queued-dispatch identity design

## Confirmed problem

Bulk and idle queue flushing assign a dispatch-scoped client message ID before
the first transport attempt and restore that identity with a failed row. The
single-chip send path in `ChatInput` does not:

1. it removes the queue row before sending;
2. a fresh row has no `messageId`, so the send layer creates an identity below
   the queue boundary;
3. if the provider accepts the prompt but the response is lost, the catch path
   creates a replacement queue row without that identity;
4. retrying the chip creates another user-message identity and can duplicate the
   accepted turn.

The invariant is that one queued row owns one transport identity from its first
dispatch attempt through every ambiguous retry.

## Design

Add one focused single-row dispatcher beside the existing bulk dispatcher in
`queuedSend.ts`.

- Atomically claim the exact queue row by its queue ID. If another sender already
  claimed it, return `false` and do not dispatch.
- Reuse an existing dispatch-scoped message ID or assign a new OpenCode-compatible
  client ID immediately before the first dispatch callback.
- On any callback failure, restore the full claimed row, including queue identity,
  creation time, captured directory/config, attachments, and dispatch identity.
- On retry, claim that restored row and reuse the same dispatch identity.

`ChatInput` continues to own agent authorization, mention/attachment preparation,
PDF validation, interruption policy, toasts, and the actual session send. It
delegates only exact-row ownership, identity, and rollback to the shared queue
module.

## Safety and scope

- The logic lives in the shared UI and therefore applies equally to web,
  Electron,.
- The helper does not drain or reorder unrelated queue rows.
- Atomic exact-row claiming closes the click-versus-idle-flush race: only the
  sender that removes the row may invoke the transport.
- A dispatch identity is not assigned at queue time, preserving chronological
  ordering relative to turns created before the row is actually sent.
- Provider/model/agent selection and interruption behavior are unchanged.

## Rejected alternatives

- Copying an ID through `ChatInput`'s catch block would duplicate identity and
  rollback rules already owned by `queuedSend.ts` and would not close the
  concurrent-claim race.
- Sending the entire queue when one chip is clicked would change single-chip UI
  semantics and could dispatch unrelated rows.
- Treating transport errors as definite rejection would hide the accepted-then-
  response-lost case and cannot prevent duplicate turns.
