//! `devryan-front`: a loopback pass-through front for `devryan serve`, used
//! only by tests and QA lanes (packages/native/DOCUMENTATION.md). It forwards
//! bytes unchanged and can supervise the JavaScript server as a child.

pub mod http;
pub mod proxy;
pub mod supervise;
pub mod sys;
pub mod util;
