# DevRyan local Bot REST: pinned PostgREST, running as the OS user that the
# database's peer map accepts for the authenticator role only.
FROM postgrest/postgrest:v14.5@sha256:b574528fe109c8343c1247155734d03df8c34b462f342dca0ccc20244fc36ef9

USER 65534:65534
HEALTHCHECK --interval=2s --timeout=5s --start-period=30s --retries=30 \
  CMD ["postgrest", "--ready"]
CMD ["postgrest"]
