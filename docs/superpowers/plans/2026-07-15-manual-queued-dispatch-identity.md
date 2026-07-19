# Manual queued-dispatch identity implementation plan

1. Add a focused red regression for an accepted-then-response-lost single-row
   attempt followed by a retry, asserting one stable dispatch identity.
2. Add a red ownership regression proving two senders cannot dispatch the same
   queue row after one exact-row claim.
3. Add the exact-row queue claim and single-row dispatcher with dispatch-time ID
   assignment and full-row rollback.
4. Route the `ChatInput` chip-send path through the shared dispatcher without
   changing validation, handoff, interruption, or toast behavior.
5. Update the chat/store documentation and run focused queue tests plus quick and
   affected validation.
6. Exercise an accepted-then-disconnected retry through a real rendered queue
   chip, verify one client ID reaches both attempts, then run the required full
   gate and production build.
