# Assistant image assets

This module authorizes and prepares completed assistant-response image candidates.
It re-reads one authoritative assistant message, accepts only supported sources
present in its Markdown or finalized image-output metadata, validates local files
by canonical containment, size, extension, and magic bytes, and returns raw-file
URLs. Generated files outside the workspace require a short-lived opaque grant
bound to the principal, canonical path, session, and message.

Remote and embedded images are never fetched by the server. Web and Electron use
the preparation route; VS Code continues through its workspace-confined raw-file
bridge and therefore cannot read generated temporary files outside the workspace.

Public route:

- `POST /api/devryan/sessions/:sessionId/image-assets/prepare`

The grant store is bounded by entry count and metadata bytes and stores no image
content. Ordinary `/api/fs/raw` authorization, including existing SVG behavior,
is unchanged when no `assetGrant` is supplied.
