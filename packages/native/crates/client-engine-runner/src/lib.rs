//! The Rust engine process of the client conformance harness (package C0i):
//! engine protocol 5 (scripts/client-conformance/engine.mjs) over stdin and
//! stdout, running the families of `devryan-client-engine`. The harness
//! starts it with `candidate.mjs --engine=<this binary>` and judges what it
//! answers; it never sees a recording, only the requests. **Nothing in the
//! product calls, bundles or ships it.**
//!
//! - `json`: JSON with UTF-16 strings, as the harness writes it;
//! - `codec`: the harness's value codec (trees, identity scope, change sets);
//! - `protocol`: the requests and answers.
#![forbid(unsafe_code)]

pub mod codec;
pub mod json;
pub mod protocol;

use std::io::{BufRead, Write};

use json::Json;
use protocol::{Answer, Runner};

/// One answer line for request `id`.
pub fn answer_line(id: Json, answer: Answer) -> Vec<u8> {
    let message = match answer {
        Answer::Ok(members) => {
            let mut all = vec![("id", id), ("ok", Json::Bool(true))];
            all.extend(members);
            Json::object(all)
        }
        Answer::Fail { error, not_ported } => {
            let mut all = vec![("id", id), ("ok", Json::Bool(false))];
            if not_ported {
                all.push(("notPorted", Json::Bool(true)));
            }
            all.push(("error", Json::String(error.encode_utf16().collect::<Vec<u16>>().into())));
            Json::object(all)
        }
    };
    let mut out = Vec::new();
    json::write(&message, &mut out);
    out.push(b'\n');
    out
}

/// Serves requests from `input` until `stop` or the end of input; answers go to `output`, one line each.
pub fn serve(input: impl BufRead, mut output: impl Write) -> std::io::Result<()> {
    let mut runner = Runner::default();
    for line in input.split(b'\n') {
        let line = line?;
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let (id, answer, stop) = match json::parse(&line) {
            Ok(request) => {
                let id = request.get("id").cloned().unwrap_or(Json::Null);
                let (answer, stop) = runner.handle(&request);
                (id, answer, stop)
            }
            Err(error) => (
                Json::Null,
                Answer::Fail {
                    error: format!("not JSON: {}", error.0),
                    not_ported: false,
                },
                false,
            ),
        };
        output.write_all(&answer_line(id, answer))?;
        output.flush()?;
        if stop {
            break;
        }
    }
    Ok(())
}
