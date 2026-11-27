//! The scheduler candidate process: the protocol on stdin and stdout
//! (`devryan_scheduler_core::wire`). `--refuse-all` refuses every case at its
//! first input (the harness's plumbing check); otherwise the core answers
//! what it ports and refuses the rest.
#![forbid(unsafe_code)]

use std::io::{BufReader, BufWriter};

fn main() {
    let refuse_all = std::env::args().skip(1).any(|arg| arg == "--refuse-all");
    let unknown: Vec<String> = std::env::args().skip(1).filter(|arg| arg != "--refuse-all").collect();
    if !unknown.is_empty() {
        eprintln!("usage: scheduler-candidate [--refuse-all] (unknown: {})", unknown.join(" "));
        std::process::exit(64);
    }
    devryan_scheduler_core::serve(
        Box::new(BufReader::new(std::io::stdin())),
        Box::new(BufWriter::new(std::io::stdout())),
        refuse_all,
    );
}
