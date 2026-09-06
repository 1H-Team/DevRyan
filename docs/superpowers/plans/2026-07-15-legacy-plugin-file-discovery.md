# Legacy plugin file discovery implementation plan

1. Extend the web read-model regression to cover singular and plural user and
   project plugin directories, then run it red.
2. Extend the VS Code parity regression with the same four-directory fixture,
   then run it red.
3. Update both read models to enumerate both directory conventions without
   changing the response shape or collapsing equal file names from distinct
   paths.
4. Document the discovery contract in the web module maps.
5. Run focused tests, affected validation, a real Plugins-page visual check,
   and post-run repository/process cleanup checks.
