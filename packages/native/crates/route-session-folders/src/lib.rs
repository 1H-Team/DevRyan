//! The `session-folders` route group of the web server
//! (packages/web/server/lib/session-folders/routes.js) as a standalone
//! candidate for the backend conformance harness (packages/native/DOCUMENTATION.md,
//! "devryan-route-session-folders"). **Nothing in the product starts, calls or
//! ships it**: the forwarding seam that could send it traffic does not exist.
//!
//! The group's two routes and its save queue (`group`) and its planted changes
//! (`plant`), on the request path every Rust group shares (devryan-route-common).

pub mod group;
pub mod plant;
