//! `dray secret`: ask the user for a token or password through a private card
//! in the chat, and find one already saved on this machine. A value never
//! crosses this wire; the agent only ever learns a file's path.

use clap::{Args, Subcommand};
use dray_proto::{Request, RequestSecret, Response, SecretName};

use crate::{parent_session_id, send, unexpected};

#[derive(Subcommand)]
pub enum SecretCommand {
    /// Ask the user for a secret through a masked card in this chat, never in
    /// chat itself. Returns at once: end your turn, and the answer reaches you
    /// as a message naming the file the value was saved to.
    Request(RequestArgs),
    /// Print the path of a secret saved on this machine, for
    /// NAME="$(cat "$(dray secret path NAME)")".
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

pub fn run(command: SecretCommand) -> Result<(), String> {
    match command {
        SecretCommand::Request(args) => request(args),
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
                    println!("{}", secret.name);
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
