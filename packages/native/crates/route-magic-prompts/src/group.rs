//! The group's four routes (packages/web/server/lib/magic-prompts/routes.js)
//! as Express 5.2.1's router dispatches them: case-insensitive, an optional
//! trailing slash, the query string ignored, HEAD answered by the GET route,
//! the `:id` parameter percent-decoded (`decodeURIComponent`; a segment it
//! cannot decode is an error the edge answers, whichever method asked), in
//! registration order: `GET /api/magic-prompts`, `PUT /api/magic-prompts/:id`,
//! `DELETE /api/magic-prompts/:id`, `DELETE /api/magic-prompts`.

use devryan_config_text::js;

use crate::answer;
use crate::body::{self, Body};
use crate::http::{Headers, Response};
use crate::order::Ticket;
use crate::plant::{self, Plant};
use crate::runtime::Runtime;

/// Which route answers, with the raw `:id` segment.
#[derive(Debug, PartialEq, Eq)]
pub enum Route<'a> {
    Collection,
    Item(&'a str),
    None,
}

const COLLECTION: &str = "/api/magic-prompts";

fn starts_with_ignoring_case(text: &str, prefix: &str) -> bool {
    if plant::on(Plant::CaseSensitiveRoutes) {
        return text.starts_with(prefix);
    }
    text.len() >= prefix.len() && text.as_bytes()[..prefix.len()].eq_ignore_ascii_case(prefix.as_bytes())
}

/// The path part of the request target, as parseurl reads it (up to `?` or `#`).
pub fn pathname(target: &str) -> &str {
    let end = target.find(['?', '#']).unwrap_or(target.len());
    &target[..end]
}

/// `^\/api\/magic-prompts(?:\/$)?$` and `^\/api\/magic-prompts\/([^\/]+)(?:\/$)?$`, case-insensitively.
pub fn route(path: &str) -> Route<'_> {
    if !starts_with_ignoring_case(path, COLLECTION) {
        return Route::None;
    }
    let rest = &path[COLLECTION.len()..];
    if rest.is_empty() || rest == "/" {
        return Route::Collection;
    }
    let Some(segment) = rest.strip_prefix('/') else { return Route::None };
    let segment = segment.strip_suffix('/').unwrap_or(segment);
    if segment.is_empty() || segment.contains('/') {
        return Route::None;
    }
    Route::Item(segment)
}

/// Express's final handler page (finalhandler 2.1.1), for what the group does not answer (no body for HEAD,
/// as Node's server writes none).
pub fn page(method: &str, status: u16, message: &str) -> Response {
    let escaped = message
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;");
    let body = format!(
        "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<title>Error</title>\n</head>\n<body>\n<pre>{escaped}</pre>\n</body>\n</html>\n"
    )
    .into_bytes();
    Response {
        status,
        headers: vec![
            ("Content-Security-Policy".to_owned(), "default-src 'none'".to_owned()),
            ("X-Content-Type-Options".to_owned(), "nosniff".to_owned()),
            ("Content-Type".to_owned(), "text/html; charset=utf-8".to_owned()),
            ("Content-Length".to_owned(), body.len().to_string()),
        ],
        body,
        head_only: method == "HEAD",
    }
}

fn status_of(validation: u16) -> u16 {
    if plant::on(Plant::Status422) && validation == 400 { 422 } else { validation }
}

fn has_lone_surrogate(text: &[u16]) -> bool {
    char::decode_utf16(text.iter().copied()).any(|decoded| decoded.is_err())
}

/// The latin1 units of a path segment (Node's request target is latin1 text: one unit per byte).
fn latin1_units(text: &str) -> Vec<u16> {
    text.bytes().map(u16::from).collect()
}

/// What a request is, as the group's composition sees it once the harness's headers are gone.
pub struct Exchange<'a> {
    pub method: &'a str,
    pub target: &'a str,
    pub headers: &'a Headers,
}

/// Answers one request the way the candidate's composition does: the product's request decoding (`body`: what
/// the parsers left in `req.body`, or the edge's refusal), the principal envelope's check (made by the protocol
/// layer), then the router. `ticket` is the request's place in the order of writes; it is released as soon as
/// the request is known not to write.
pub fn handle(runtime: &Runtime, exchange: &Exchange, body: Result<Body, body::Refusal>, envelope: Result<(), String>, ticket: &Ticket) -> Response {
    let response = route_request(runtime, exchange, body, envelope, ticket);
    ticket.release();
    response
}

fn route_request(runtime: &Runtime, exchange: &Exchange, body: Result<Body, body::Refusal>, envelope: Result<(), String>, ticket: &Ticket) -> Response {
    let Exchange { method, target, headers } = *exchange;
    let path = pathname(target);
    let decoded = match body {
        Ok(decoded) => decoded,
        Err(refusal) => return page(method, refusal.status, &refusal.message),
    };
    if let Err(message) = envelope {
        return answer::json(method, headers, 400, answer::error_body(&message));
    }
    match route(path) {
        Route::Collection if method == "GET" || method == "HEAD" => {
            // A read never waits for its turn: the JavaScript reads without the lock. It keeps its place until it has
            // read, so a write whose handler ran after it cannot truncate the file under it (in Node the read is on the
            // thread pool before that write's own read, parse and truncation are).
            if plant::on(Plant::GetWaitsForTurn) {
                ticket.wait();
            }
            let state = runtime.read_prompt_state();
            ticket.release();
            answer::json(method, headers, 200, crate::runtime::stringify_utf8(&state, false))
        }
        Route::Collection if method == "DELETE" => match runtime.reset_all_overrides(ticket) {
            Ok(state) => answer::json(method, headers, 200, crate::runtime::stringify_utf8(&state, false)),
            Err(message) => {
                let message = if message.is_empty() {
                    "Failed to reset magic prompts".to_owned()
                } else {
                    message
                };
                answer::json(method, headers, 500, answer::error_body(&message))
            }
        },
        Route::Item(segment) => {
            let raw = latin1_units(segment);
            let Ok(id) = js::decode_uri_component(&raw) else {
                return page(method, 400, &format!("URIError: Failed to decode param '{segment}'"));
            };
            match method {
                "PUT" => put(runtime, ticket, method, headers, &id, &decoded),
                "DELETE" => match runtime.reset_override(ticket, &id) {
                    Ok(state) => answer::json(method, headers, 200, crate::runtime::stringify_utf8(&state, false)),
                    Err(message) => {
                        let status = if message.contains("Invalid prompt id") { status_of(400) } else { 500 };
                        answer::json(method, headers, status, answer::error_body(&message))
                    }
                },
                _ => page(method, 404, &format!("Cannot {method} {path}")),
            }
        }
        _ => page(method, 404, &format!("Cannot {method} {path}")),
    }
}

fn put(runtime: &Runtime, ticket: &Ticket, method: &str, headers: &Headers, id: &[u16], decoded: &Body) -> Response {
    let Some(text) = body::text_field(decoded) else {
        let message = if plant::on(Plant::ErrorText) {
            "text is required."
        } else {
            "text is required"
        };
        return answer::json(method, headers, status_of(400), answer::error_body(message));
    };
    if plant::on(Plant::LoneSurrogateRejected) && has_lone_surrogate(&text) {
        return answer::json(method, headers, 400, answer::error_body("text is not well-formed"));
    }
    match runtime.set_override(ticket, id, &text) {
        Ok(state) => answer::json(method, headers, 200, crate::runtime::stringify_utf8(&state, false)),
        Err(message) => {
            let validation = ["Invalid prompt id", "Deprecated prompt id", "too long", "cannot be empty"]
                .iter()
                .any(|needle| message.contains(needle));
            let status = if validation { status_of(400) } else { 500 };
            answer::json(method, headers, status, answer::error_body(&message))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_like_express() {
        assert_eq!(route("/api/magic-prompts"), Route::Collection);
        assert_eq!(route("/API/Magic-Prompts/"), Route::Collection);
        assert_eq!(route("/api/magic-prompts/a.b"), Route::Item("a.b"));
        assert_eq!(route("/api/magic-prompts/a.b/"), Route::Item("a.b"));
        assert_eq!(route("/api/magic-prompts/a.b//"), Route::None);
        assert_eq!(route("/api/magic-prompts//"), Route::None);
        assert_eq!(route("/api/magic-prompts/a/b"), Route::None);
        assert_eq!(route("/api/magic%2Dprompts"), Route::None);
        assert_eq!(route("//api/magic-prompts"), Route::None);
        assert_eq!(route("/api/magic-promptsx"), Route::None);
        assert_eq!(pathname("/api/magic-prompts?x=1"), "/api/magic-prompts");
    }

    #[test]
    fn head_pages_have_no_body() {
        // Node's server writes no body after a HEAD answer, the final handler's pages included.
        assert!(page("HEAD", 404, "Cannot HEAD /api/other").head_only);
        assert!(!page("GET", 404, "Cannot GET /api/other").head_only);
        let runtime = Runtime::new("/nonexistent-devryan-route-test");
        let headers = Headers::from_pairs(&[]);
        let exchange = Exchange {
            method: "HEAD",
            target: "/api/magic-prompts/%zz",
            headers: &headers,
        };
        let answer = handle(&runtime, &exchange, Ok(Body::Unparsed), Ok(()), &Ticket::alone());
        assert_eq!((answer.status, answer.head_only), (400, true));
    }
}
