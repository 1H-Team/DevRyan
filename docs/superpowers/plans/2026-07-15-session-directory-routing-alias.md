# Session directory routing alias implementation plan

1. Add a failing `createSessionRecord` test where the request directory is
   `/tmp/project` and OpenCode returns `/private/tmp/project`; assert that routing
   registration and the UI hint both use `/tmp/project`.
2. Add failing pure tests for sidebar directory resolution, including hint-first,
   server-directory fallback, and group-directory fallback cases.
3. Change creation-time routing precedence without modifying the returned session
   record.
4. Add a narrow leaf selector to `SessionNodeItem` and route through the tested
   resolver.
5. Update sidebar and sync documentation/codemaps for the ownership rule.
6. Run focused tests, live visual verification, affected/full validation, and the
   production build; then remove all disposable sessions, worktrees, servers, and
   browser state.
