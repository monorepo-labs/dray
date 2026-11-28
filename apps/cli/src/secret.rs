//! `dray secret`: ask the user for a token or password through a private card
//! in the chat, take a card back, and find one already saved on this machine. A value never
//! crosses this wire; the agent only ever learns a file's path.

use clap::{Args, Subcommand};
use dray_proto::{CancelSecret, Request, RequestSecret, Response, SecretName};

use crate::{parent_session_id, send, unexpected};

#[derive(Subcommand)]
pub enum SecretCommand {
    /// Ask the user for a secret through a masked card in this chat, never in
    /// chat itself. Returns at once: end your turn, and the answer reaches you
    /// as a message naming the file the value was saved to.
    Request(RequestArgs),
    /// Take back this chat's open card for NAME once you no longer need it, as
    /// when you found another way in. The card closes everywhere and no answer
    /// comes. Only this session's own cards.
    Cancel(NameArg),
    /// Print the path of a saved secret agents may use without asking. Any other
    /// saved one is asked for with `request`, which offers it in one click.
    Path(NameArg),
    /// List the secrets saved on this machine, by name.
    Ls,
}

#[derive(Args)]
pub struct RequestArgs {
    /// What you call it, like GITHUB_TOKEN: letters, digits and _.
    name: String,
    /// Why you need it, in one sentence the user reads before pasting.
    #[arg(long)]
    reason: String,
    /// The card's heading, where it should read better than the name.
    #[arg(long)]
    label: Option<String>,
    /// Where the user makes or finds one, like a tokens settings page.
    #[arg(long)]
    url: Option<String>,
}

#[derive(Args)]
pub struct NameArg {
    name: String,
}

/// `dray secret request|cancel|ls|path`, against the server named by the socket.
pub fn run(command: SecretCommand) -> Result<(), String> {
    match command {
        SecretCommand::Request(args) => request(args),
        SecretCommand::Cancel(args) => cancel(args.name),
        SecretCommand::Path(args) => match send(Request::SecretPath(SecretName { name: args.name }))? {
            Response::SecretPath { path, .. } => {
                println!("{path}");
                Ok(())
            }
            Response::Error { message } => Err(message),
            other => Err(unexpected(other)),
        },
        SecretCommand::Ls => match send(Request::ListSecrets)? {
            Response::Secrets { secrets } if secrets.is_empty() => {
                eprintln!("No secrets saved on this machine.");
                Ok(())
            }
            Response::Secrets { secrets } => {
                for secret in secrets {
                    let always = if secret.always { "  (used without asking)" } else { "" };
                    println!("{}{always}", secret.name);
                }
                Ok(())
            }
            Response::Error { message } => Err(message),
            other => Err(unexpected(other)),
        },
    }
}

fn request(args: RequestArgs) -> Result<(), String> {
    let session_id =
        parent_session_id().ok_or("run this from inside a Dray session: the card goes in its chat.")?;
    let ask = RequestSecret { session_id, name: args.name, label: args.label, reason: args.reason, url: args.url };
    match send(Request::RequestSecret(ask))? {
        Response::SecretRequested { name, path: Some(path), .. } => {
            println!(
                "{name} is saved on this machine and the user lets agents use it without asking, so no card went up. Its value is in {path}. \
                 Use it inside the command that needs it, like <command> < {path}, or {name}=\"$(cat {path})\" <command>. \
                 Never print, echo or copy the value."
            );
            Ok(())
        }
        Response::SecretRequested { name, bot: true, .. } => {
            println!(
                "Asked the user for {name} in your bot's chat: your bot's machine keeps the secrets you use. End your turn \
                 now and say you're waiting on it. Their answer reaches you as a message: the path of a file here holding \
                 the value, or that they declined. Never ask for it in chat."
            );
            Ok(())
        }
        Response::SecretRequested { name, replaced, .. } => {
            let again = if replaced { " It replaces the card you posted for it before." } else { "" };
            println!(
                "Asked the user for {name} in a private card in this chat.{again} End your turn now and say you're \
                 waiting on it. Their answer reaches you as a message: the path of a file holding the value, or that \
                 they declined. Never ask for it in chat."
            );
            Ok(())
        }
        Response::Error { message } => Err(message),
        other => Err(unexpected(other)),
    }
}

fn cancel(name: String) -> Result<(), String> {
    let session_id =
        parent_session_id().ok_or("run this from inside a Dray session: it takes back that chat's own card.")?;
    match send(Request::CancelSecret(CancelSecret { session_id, name }))? {
        Response::SecretCancelled { name, withdrawn: true } => {
            println!("Took back the card for {name}. It is gone from the chat, and no answer will come for it.");
            Ok(())
        }
        Response::SecretCancelled { name, withdrawn: false } => {
            println!(
                "No card for {name} is open in this chat: it was answered, declined or taken back already, or never \
                 asked here. Nothing changed."
            );
            Ok(())
        }
        Response::Error { message } => Err(message),
        other => Err(unexpected(other)),
    }
}
