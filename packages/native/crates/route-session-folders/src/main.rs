//! The `devryan-route-session-folders` command: the harness's candidate protocol over the group (src/group.rs).
//! See packages/native/DOCUMENTATION.md.

/// Big blocks straight from the kernel, so a request's 4 MiB document is not kept resident after it (alloc.rs).
#[global_allocator]
static ALLOCATOR: devryan_route_common::alloc::BigBlocksMapped = devryan_route_common::alloc::BigBlocksMapped;

fn main() {
    devryan_route_common::server::main::<devryan_route_session_folders::group::SessionFolders>();
}
