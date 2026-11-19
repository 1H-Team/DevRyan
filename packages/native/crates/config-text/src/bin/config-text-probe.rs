//! Test-only probe: reads rows `op<TAB>arg...` (arguments as vector fields)
//! on stdin and writes one line per row: the result field, or `error<TAB>why`.
//! tests/config-text-differential.mjs runs extra inputs through it and through the
//! JavaScript packages.
use std::io::{BufRead, Write};

use devryan_config_text::vector;

fn main() {
    let stdin = std::io::stdin();
    let mut stdout = std::io::BufWriter::new(std::io::stdout().lock());
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let mut fields = line.split('\t');
        let op = fields.next().unwrap_or_default().to_owned();
        let answer = fields
            .map(vector::field)
            .collect::<Result<Vec<_>, _>>()
            .and_then(|args| vector::run(&op, &args))
            .map(|result| vector::encode_field(&result));
        let written = match answer {
            Ok(field) => writeln!(stdout, "{field}"),
            Err(why) => writeln!(stdout, "error\t{why}"),
        };
        if written.is_err() {
            break;
        }
    }
    let _ = stdout.flush();
}
