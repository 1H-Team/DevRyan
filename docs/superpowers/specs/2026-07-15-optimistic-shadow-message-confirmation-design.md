# Optimistic Shadow Message Confirmation Design

## Problem

Optimistic sends register the client-created user message and its parts in both
the visible sync store and a shadow Map. The client-generated message ID is
passed to OpenCode, but the optimistic part IDs are not part of the prompt
request. OpenCode therefore returns the same authoritative message ID with its
own part IDs.

The live part reducer correctly replaces an optimistic same-type part with the
authoritative server part. A later REST message load, however, clears the
shadow item only when every optimistic part ID is present in the fetched
record. That condition cannot hold for normal server-generated part IDs, so
the merge adds the obsolete optimistic parts back to the authoritative page
and retains the shadow item for future loads.

## Source of truth

A message record fetched from OpenCode with the exact client-generated message
ID is the authoritative acknowledgement of that optimistic message. The REST
record and its parts own the loaded snapshot once that identity is present.

## Design

When mergeOptimisticPage finds the optimistic message ID in the fetched page,
mark that shadow item confirmed and leave the fetched server parts unchanged.
Only shadow messages that are absent from the fetched page continue to be
inserted with their optimistic parts.

This keeps the existing protection for requests whose message has not reached
the authoritative page yet, while preventing confirmed messages from
reintroducing client-only part identities.

## Alternatives rejected

- Match parts by text, file name, or MIME type: provider transformations,
  synthetic context, and repeated equal text make those heuristics ambiguous.
- Send client part IDs to OpenCode: the prompt input contract does not accept
  those output record identities, while the message ID contract already gives
  a deterministic acknowledgement boundary.
- Clear the shadow item from the live part reducer: part events can arrive
  before the owning message is durably visible to the REST page, so the fetched
  message identity is the stronger confirmation signal.

## Verification

- Merge a fetched server message whose ID matches the optimistic message while
  its authoritative text part has a different ID.
- Confirm the shadow message ID is returned for cleanup and only the server
  part remains in the merged page.
- Keep absent optimistic messages and their parts visible.
- Run focused tests, the full optimistic suite, affected validation, a
  disposable browser refetch proof, and isolation/diff checks.
