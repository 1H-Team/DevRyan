//! The harness's candidate protocol for this group (devryan_route_common::server):
//!
//!   devryan-route-magic-prompts --listen 127.0.0.1:0 --control 127.0.0.1:0 --data-root <dir> --home <dir>
//!       [--stub name=URL ...] [--plant <id>]   (--plant: a build with the plants feature only)
//!
//! The group has no outbound call and no use for HOME; both options are accepted as the protocol hands them out.

use devryan_route_common::body::{Refusal, TopLevelText};
use devryan_route_common::http::Response;
use devryan_route_common::order::Ticket;
use devryan_route_common::server::{self, Exchange, Group};

use crate::body::Body;
use crate::runtime::Runtime;

/// The group as the shared server serves it.
pub struct MagicPrompts(Runtime);

impl Group for MagicPrompts {
    type Reader = TopLevelText;
    const COMMAND: &'static str = "devryan-route-magic-prompts";

    fn plant_ids() -> Vec<&'static str> {
        crate::plant::ids()
    }

    fn new(data_root: &str) -> Self {
        MagicPrompts(Runtime::new(data_root))
    }

    fn handle(&self, exchange: &Exchange, body: Result<Body, Refusal>, envelope: Result<(), String>, ticket: &Ticket) -> Response {
        crate::group::handle(&self.0, exchange, body, envelope, ticket)
    }
}

/// The command: never returns.
pub fn main() -> ! {
    server::main::<MagicPrompts>()
}
