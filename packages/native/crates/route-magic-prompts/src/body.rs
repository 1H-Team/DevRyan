//! The product's request decoding as this group reads it (devryan_route_common::body):
//! a JSON body is read for its top-level `text` only.

pub use devryan_route_common::body::{
    Content, ContentType, Encoding, JsonReader, Plan, Reader, Refusal, TopLevelText, content_of, decode, decode_charset, identity_content, inflate_content,
    parse, parse_content_type, plan, shared_json_limit, text_field,
};

/// `req.body` as the group's handlers see it (what they read of it: `req.body?.text` when it is a string).
pub type Body = devryan_route_common::body::Body<Option<Vec<u16>>>;
