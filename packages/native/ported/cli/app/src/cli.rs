use std::ffi::OsString;

use clap::{Arg, ArgAction, Command, value_parser};

/// The command `units::dispatch` gets when argv names no subcommand.
pub const ROOT: &str = "devryan";

fn rest() -> Arg {
    Arg::new("args")
        .num_args(0..)
        .trailing_var_arg(true)
        .allow_hyphen_values(true)
        .value_parser(value_parser!(OsString))
}

/// Routes argv to a command. Anything this parser rejects runs the original, so it never
/// has to match every way the original accepts its arguments.
pub fn command() -> Command {
    Command::new(ROOT)
        .disable_help_flag(true)
        .disable_version_flag(true)
        .disable_help_subcommand(true)
        .args_conflicts_with_subcommands(true)
        .arg(rest())
        .subcommand(
            Command::new("enroll-owner")
                .disable_help_flag(true)
                .arg(Arg::new("help").long("help").action(ArgAction::Count))
                .arg(rest()),
        )
        .subcommand(
            Command::new("frobnicate")
                .disable_help_flag(true)
                .arg(Arg::new("help").long("help").action(ArgAction::Count))
                .arg(rest()),
        )
        .subcommand(
            Command::new("logs")
                .disable_help_flag(true)
                .arg(Arg::new("help").long("help").action(ArgAction::Count))
                .arg(rest()),
        )
        .subcommand(
            Command::new("restart")
                .disable_help_flag(true)
                .arg(Arg::new("short-h").short('h').action(ArgAction::Count))
                .arg(rest()),
        )
        .subcommand(
            Command::new("runtime")
                .disable_help_flag(true)
                .arg(Arg::new("help").long("help").action(ArgAction::Count))
                .arg(rest()),
        )
        .subcommand(
            Command::new("serve")
                .disable_help_flag(true)
                .arg(Arg::new("help").long("help").action(ArgAction::Count))
                .arg(Arg::new("version").long("version").action(ArgAction::Count))
                .arg(rest()),
        )
        .subcommand(
            Command::new("status")
                .disable_help_flag(true)
                .arg(Arg::new("help").long("help").action(ArgAction::Count))
                .arg(Arg::new("json").long("json").action(ArgAction::Count))
                .arg(Arg::new("plain").long("plain").action(ArgAction::Count))
                .arg(Arg::new("quiet").long("quiet").action(ArgAction::Count))
                .arg(Arg::new("short-q").short('q').action(ArgAction::Count))
                .arg(rest()),
        )
        .subcommand(
            Command::new("stop")
                .disable_help_flag(true)
                .arg(Arg::new("help").long("help").action(ArgAction::Count))
                .arg(rest()),
        )
        .subcommand(
            Command::new("tunnel")
                .disable_help_flag(true)
                .arg(Arg::new("help").long("help").action(ArgAction::Count))
                .arg(Arg::new("json").long("json").action(ArgAction::Count))
                .arg(
                    Arg::new("provider")
                        .long("provider")
                        .action(ArgAction::Count),
                )
                .arg(Arg::new("quiet").long("quiet").action(ArgAction::Count))
                .arg(Arg::new("short-h").short('h').action(ArgAction::Count))
                .arg(Arg::new("short-v").short('v').action(ArgAction::Count))
                .arg(rest()),
        )
        .subcommand(
            Command::new("update")
                .disable_help_flag(true)
                .arg(Arg::new("help").long("help").action(ArgAction::Count))
                .arg(rest()),
        )
}
