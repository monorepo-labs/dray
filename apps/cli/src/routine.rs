use clap::{Args, Subcommand};
use dray_proto::{AddRoutine, Request, Response, RoutineRef, RoutineScope, RoutineSummary, SetRoutinePaused};

use super::{parent_session_id, send, unexpected};

#[derive(Subcommand)]
pub enum RoutineCommand {
    /// Make a routine: a prompt Dray sends this bot on a schedule. The user
    /// sees it in the bot's Routines tab and can pause or delete it.
    Add(AddArgs),
    /// List this bot's routines, with next run and last result.
    Ls(LsArgs),
    /// Stop a routine running until it is resumed.
    Pause(RoutineArg),
    /// Start a paused routine again, counting from now.
    Resume(RoutineArg),
    /// Delete a routine.
    Rm(RoutineArg),
    /// Run a routine on the next tick, whatever its schedule, to try it.
    Run(RoutineArg),
}

#[derive(Args)]
pub struct AddArgs {
    /// A short name the user will recognise, like "PR watch".
    name: String,
    /// What to do each run. Write it to be read cold: it arrives with no
    /// context but your memory and notes.
    prompt: String,
    /// Run every interval: 30m, 2h, 1d. At least 5m.
    #[arg(long)]
    every: Option<String>,
    /// Run at a local time: 09:00, 9am, 5:30pm.
    #[arg(long)]
    at: Option<String>,
    /// With --at: weekdays, weekends, daily, or mon,wed,fri. Daily without it.
    #[arg(long)]
    days: Option<String>,
    /// A shell command run in the bot's folder first. You are woken only when
    /// its output differs from the last run, so print only what matters, and
    /// nothing that changes every time (no timestamps).
    #[arg(long)]
    check: Option<String>,
    /// The bot's name or id. The calling bot's own without it.
    #[arg(long)]
    bot: Option<String>,
}

#[derive(Args)]
pub struct LsArgs {
    /// The bot's name or id. The calling bot's own without it, else all.
    #[arg(long)]
    bot: Option<String>,
    /// One JSON array, for reading with a program.
    #[arg(long)]
    json: bool,
}

#[derive(Args)]
pub struct RoutineArg {
    /// The routine's id, or its name.
    routine: String,
}

pub fn run(command: RoutineCommand) -> Result<(), String> {
    let from_session_id = parent_session_id();
    let one = |routine: String| RoutineRef { routine, from_session_id: from_session_id.clone() };
    let paused = |routine: String, paused: bool| {
        Request::SetRoutinePaused(SetRoutinePaused { routine, paused, from_session_id: from_session_id.clone() })
    };
    match command {
        RoutineCommand::Add(args) => {
            let request = Request::AddRoutine(AddRoutine {
                bot: args.bot,
                from_session_id: from_session_id.clone(),
                name: args.name,
                prompt: args.prompt,
                every: args.every,
                at: args.at,
                days: args.days,
                check: args.check,
            });
            let routine = answered(send(request)?)?;
            println!("{}", routine.id);
            eprintln!("Made \"{}\", {}. {}", routine.name, routine.schedule.to_lowercase(), next(&routine));
            Ok(())
        }
        RoutineCommand::Ls(args) => match send(Request::ListRoutines(RoutineScope { bot: args.bot, from_session_id }))? {
            Response::Routines { routines } => {
                if args.json {
                    println!("{}", serde_json::to_string_pretty(&routines).unwrap_or_default());
                } else if routines.is_empty() {
                    eprintln!("No routines.");
                } else {
                    for r in &routines {
                        println!("{}", line(r));
                    }
                }
                Ok(())
            }
            Response::Error { message } => Err(message),
            other => Err(unexpected(other)),
        },
        RoutineCommand::Pause(args) => {
            let routine = answered(send(paused(args.routine, true))?)?;
            eprintln!("Paused \"{}\".", routine.name);
            Ok(())
        }
        RoutineCommand::Resume(args) => {
            let routine = answered(send(paused(args.routine, false))?)?;
            eprintln!("Resumed \"{}\". {}", routine.name, next(&routine));
            Ok(())
        }
        RoutineCommand::Rm(args) => {
            let routine = answered(send(Request::RemoveRoutine(one(args.routine)))?)?;
            eprintln!("Deleted \"{}\".", routine.name);
            Ok(())
        }
        RoutineCommand::Run(args) => {
            let routine = answered(send(Request::RunRoutine(one(args.routine)))?)?;
            eprintln!("\"{}\" runs within 30 seconds, once this bot's turn has ended.", routine.name);
            Ok(())
        }
    }
}

fn answered(response: Response) -> Result<RoutineSummary, String> {
    match response {
        Response::Routine { routine } => Ok(routine),
        Response::Error { message } => Err(message),
        other => Err(unexpected(other)),
    }
}

fn next(r: &RoutineSummary) -> String {
    r.next_run.as_deref().map(|n| format!("Next run {n}.")).unwrap_or_default()
}

/// One routine per line: id, state, schedule, name, then its check and last
/// result indented beneath.
fn line(r: &RoutineSummary) -> String {
    let state = if r.paused { "paused".to_string() } else { format!("next {}", r.next_run.as_deref().unwrap_or("-")) };
    let mut out = format!("{}  {:<22}  {}  ({}, bot {})", r.id, r.schedule, r.name, state, r.bot);
    if let Some(check) = &r.check {
        out.push_str(&format!("\n    check: {check}"));
    }
    if let Some(last) = &r.last_result {
        out.push_str(&format!("\n    last: {last} ({})", r.last_run.as_deref().unwrap_or("-")));
    }
    out
}
