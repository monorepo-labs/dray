use clap::{Args, Subcommand};
use dray_proto::{BotRef, BotSummary, CreateBot, RenameBot, Request, Response, SendToBot};

use super::{parent_session_id, send, unexpected};

#[derive(Subcommand)]
pub enum BotCommand {
    /// Make a bot: one long-lived chat with instructions and memory of its own.
    New(NewBot),
    /// List bots, with each one's chat.
    Ls(BotLs),
    /// Message a bot. It lands in the bot's chat; nothing comes back on its own.
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

pub fn run(command: BotCommand) -> Result<(), String> {
    match command {
        BotCommand::New(args) => {
            let hue = args.colour.as_deref().map(hue).transpose()?;
            let request = Request::CreateBot(CreateBot { name: args.name, shape: args.shape, hue });
            let bot = answered(send(request)?)?;
            println!("{}", bot.id);
            eprintln!(
                "Made \"{}\". Its chat starts with the first message: `dray bot send \"{}\" \"<message>\"`.",
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
/// then its name.
fn line(bot: &BotSummary) -> String {
    format!("{}  {:<36}  {}", bot.id, bot.session_id.as_deref().unwrap_or("-"), bot.name)
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
}
