//! `devryan-ledger`: the native ledger process (research file 28, section
//! 1.2). stdin and stdout carry the protocol (`ledger_native::proto`),
//! stderr free text. It exits at once, without unwinding, when stdin closes
//! (0), when its parent is gone (0, checked every 250 ms), when a line is
//! corrupt or longer than 256 MiB (70), when stdout fails (70), and before
//! `ready` when `init` is refused (70). Nothing in the product starts it.
#![forbid(unsafe_code)]

fn main() {
    ledger_native::process::run();
}
