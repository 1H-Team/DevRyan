//! `client-engine-runner [--plant=<id>] | --plants`: the Rust engine of the
//! client conformance harness, speaking engine protocol 5 on stdin and
//! stdout (`candidate.mjs --engine=<this binary>`). `--plant=<id>` turns on
//! one planted difference of `devryan-client-engine` for the whole run;
//! `--plants` prints every planted difference (`<id>\t<family>\t<change>`)
//! and exits. Exit codes: 0 after `stop` or the end of input, 64 for a usage
//! error (an unknown option or planted difference), 74 when stdin or stdout
//! fails.

use std::io::Write;
use std::process::ExitCode;

use devryan_client_engine::{plant, plants::PLANTS};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|arg| arg == "--plants") && args.len() == 1 {
        let mut out = std::io::stdout().lock();
        for item in PLANTS {
            if writeln!(out, "{}\t{}\t{}", item.id, item.family, item.change).is_err() {
                return ExitCode::from(74);
            }
        }
        return ExitCode::SUCCESS;
    }
    for arg in &args {
        let Some(id) = arg.strip_prefix("--plant=") else {
            eprintln!("client-engine-runner: unknown argument {arg}\nusage: client-engine-runner [--plant=<id>] | --plants");
            return ExitCode::from(64);
        };
        if let Err(error) = plant::activate(id) {
            eprintln!("client-engine-runner: {error}");
            return ExitCode::from(64);
        }
    }
    let stdin = std::io::stdin().lock();
    let stdout = std::io::stdout().lock();
    match devryan_client_engine_runner::serve(stdin, std::io::BufWriter::new(stdout)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("client-engine-runner: {error}");
            ExitCode::from(74)
        }
    }
}
