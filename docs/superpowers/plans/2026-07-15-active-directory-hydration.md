# Active-directory hydration implementation plan

1. Add red tests for a shared normalized active-directory predicate and for
   user/archived hydration candidate selection.
2. Extract the duplicated session-directory resolver into the existing sidebar
   hydration utility module and apply the predicate to both activity hooks.
3. Extract the sidebar child-target builder from `SessionSidebar.tsx`, test it,
   and exclude inactive directories before `useEnsureSessionChildren` mounts.
4. Add a pure same-directory neighbor selector to `useSessionPrefetch.ts`, test
   it, and pass the current directory from `SessionSidebar.tsx`.
5. Make inactive explicit-directory sync subscriptions passive, and restrict
   provider configuration/reconnect/replay recovery to the normalized active
   store while preserving imperative bootstrap authority.
6. Update sidebar and sync documentation with the lifecycle boundary, cached
   fallback behavior, and recovery policy.
7. Run focused tests, `validate:quick`, `validate:affected`, `validate:full`, and
   `bun run build`.
8. Repeat the isolated guarded UI startup, verify process ancestry and request
   scope, close the diagnostic tab, stop only isolated processes, and confirm the
   Test repository remains clean.
