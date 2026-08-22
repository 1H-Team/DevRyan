# packages/web/server/lib/image-assets/

## Responsibility

Message-scoped assistant image authorization, validation, preparation, and
short-lived path-bound grants for the existing raw-file route.

## Flow

1. Authenticate and authorize the session.
2. Fetch one authoritative completed assistant message.
3. Match requested sources against its Markdown and finalized image metadata.
4. Canonicalize and validate workspace or generated temporary files.
5. Return ordinary raw URLs or principal/path-bound grant URLs.
