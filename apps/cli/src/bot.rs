use clap::{Args, Subcommand};
use dray_proto::{BotRef, BotSummary, CreateBot, RenameBot, Request, Response, SendToBot};

use super::{parent_session_id, send, unexpected, MACHINE};

#[derive(Subcommand)]
pub enum BotCommand {
    /// Make a bot: one long-lived chat with instructions and memory of its own.
    New(NewBot),
    /// List bots: each one's chat, role, whether it is working, and its open tasks.
    Ls(BotLs),
    /// Message a bot. It lands in the bot's chat; with --ask its answer comes back to you.
    Send(BotSend),
    /// Rename a bot.
    Rename(BotRename),
    /// Delete a bot: its chat is settled and its folder deleted.
    Rm(BotArg),
    /// Scheduled checks a bot runs on itself, which the user can see and stop.
    #[command(subcommand)]
    Routine(crate::routine::RoutineCommand),
}

/// The colours a face can take, as the app's picker names them.
const COLOURS: [(&str, f64); 8] = [
    ("red", 25.0),
    ("orange", 50.0),
    ("amber", 80.0),
    ("green", 145.0),
    ("teal", 185.0),
    ("blue", 250.0),
    ("purple", 295.0),
    ("pink", 340.0),
];

#[derive(Args)]
pub struct NewBot {
    name: String,
    /// Its face: round, organic, boxy, capsule, nub, cloud, hexagon, sun or
    /// triangle. Picked at random without it.
    #[arg(long)]
    shape: Option<String>,
    /// Its colour: red, orange, amber, green, teal, blue, purple, pink, or a
    /// hue in degrees. Picked at random without it.
    #[arg(long, alias = "color")]
    colour: Option<String>,
}

#[derive(Args)]
pub struct BotLs {
    /// One JSON array, for reading with a program.
    #[arg(long)]
    json: bool,
}

#[derive(Args)]
pub struct BotSend {
    /// The bot's name or id, as `dray bot ls` prints them.
    bot: String,
    /// The message. Write it for someone who cannot see your conversation.
    prompt: String,
    /// Wants an answer: Dray passes the bot's reply back to your chat when its
    /// turn ends. Without it nothing comes back on its own.
    #[arg(long)]
    ask: bool,
}

#[derive(Args)]
pub struct BotRename {
    /// The bot's name or id.
    bot: String,
    name: String,
}

#[derive(Args)]
pub struct BotArg {
    /// The bot's name or id.
    bot: String,
}

/// Why `--machine` cannot carry `command`, or `None` where it can.
pub fn machine_refusal(command: &BotCommand) -> Option<String> {
    match command {
        BotCommand::Routine(command) => crate::routine::machine_refusal(command),
        _ => None,
    }
}

pub fn run(command: BotCommand) -> Result<(), String> {
    match command {
        BotCommand::New(args) => {
            let hue = args.colour.as_deref().map(hue).transpose()?;
            let request = Request::CreateBot(CreateBot { name: args.name, shape: args.shape, hue });
            let bot = answered(send(request)?)?;
            println!("{}", bot.id);
            let machine = MACHINE.get().map(|m| format!("--machine {m} ")).unwrap_or_default();
            eprintln!(
                "Made \"{}\". Its chat starts with the first message: `dray {machine}bot send \"{}\" \"<message>\"`.",
                bot.name, bot.name
            );
            Ok(())
        }
        BotCommand::Ls(args) => match send(Request::ListBots)? {
            Response::Bots { bots } => {
                if args.json {
                    println!("{}", serde_json::to_string_pretty(&bots).unwrap_or_default());
                } else if bots.is_empty() {
                    eprintln!("No bots.");
                } else {
                    for bot in &bots {
                        println!("{}", line(bot));
                        for detail in details(bot) {
                            println!("    {detail}");
                        }
                    }
                }
                Ok(())
            }
            Response::Error { message } => Err(message),
            other => Err(unexpected(other)),
        },
        BotCommand::Send(args) => {
            let request = Request::SendToBot(SendToBot {
                bot: args.bot,
                prompt: args.prompt,
                from_session_id: parent_session_id(),
                ask: args.ask,
            });
            match send(request)? {
                Response::BotSent { bot, queued } => {
                    // The app's chat reads this line back for the id, which
                    // still names the bot once the name typed here no longer
                    // does: keep the shape in step with `botTranscript.ts`.
                    let verb = if queued { "Queued for" } else { "Sent to" };
                    println!("{verb} bot \"{}\" ({}).", bot.name, bot.id);
                    if queued {
                        eprintln!("It is mid-turn and will pick it up.");
                    }
                    Ok(())
                }
                Response::Error { message } => Err(message),
                other => Err(unexpected(other)),
            }
        }
        BotCommand::Rename(args) => {
            let bot = answered(send(Request::RenameBot(RenameBot { bot: args.bot, name: args.name }))?)?;
            eprintln!("Renamed it \"{}\".", bot.name);
            Ok(())
        }
        BotCommand::Rm(args) => {
            let bot = answered(send(Request::RemoveBot(BotRef { bot: args.bot }))?)?;
            eprintln!("Deleted \"{}\".", bot.name);
            Ok(())
        }
        BotCommand::Routine(command) => crate::routine::run(command),
    }
}

fn answered(response: Response) -> Result<BotSummary, String> {
    match response {
        Response::Bot { bot } => Ok(bot),
        Response::Error { message } => Err(message),
        other => Err(unexpected(other)),
    }
}

/// A project's own name, not the whole path. Either separator, whatever this
/// machine's: a bot's task can live on a Windows server named from a Mac.
fn project_name(path: &str) -> &str {
    path.trim_end_matches(['/', '\\']).rsplit(['/', '\\']).next().filter(|n| !n.is_empty()).unwrap_or(path)
}

/// A colour by name, or a hue in degrees.
fn hue(colour: &str) -> Result<f64, String> {
    let colour = colour.trim().to_lowercase();
    if let Some((_, hue)) = COLOURS.iter().find(|(name, _)| *name == colour) {
        return Ok(*hue);
    }
    colour.parse::<f64>().map_err(|_| {
        let names: Vec<_> = COLOURS.iter().map(|(name, _)| *name).collect();
        format!("no colour {colour:?} — try {}, or a hue in degrees", names.join(", "))
    })
}

/// One bot per line: id, its chat's session (or a dash before it has one),
/// then its name and whether it is working.
fn line(bot: &BotSummary) -> String {
    let working = if bot.working { "  (working)" } else { "" };
    format!("{}  {:<36}  {}{working}", bot.id, bot.session_id.as_deref().unwrap_or("-"), bot.name)
}

/// The indented lines under a bot: its role, then one per open task.
fn details(bot: &BotSummary) -> Vec<String> {
    let mut out = vec![format!("role: {}", bot.role.as_deref().unwrap_or("none written yet"))];
    for task in &bot.tasks {
        let project = project_name(&task.project_path);
        let branch = task.branch.as_deref().map(|b| format!(", {b}")).unwrap_or_default();
        let working = if task.working { ", working" } else { "" };
        out.push(format!("task: \"{}\" ({}) in {project}{branch}{working}", task.title, task.session_id));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_colour_is_a_name_or_degrees() {
        assert_eq!(hue("Teal"), Ok(185.0));
        assert_eq!(hue("200"), Ok(200.0));
        assert!(hue("mauve").unwrap_err().contains("teal"));
    }

    #[test]
    fn a_task_names_its_project_not_its_whole_path() {
        assert_eq!(project_name(r"C:\work\my repo"), "my repo");
        assert_eq!(project_name("/work/my repo/"), "my repo");
    }
}
