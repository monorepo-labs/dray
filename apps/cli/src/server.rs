use std::io::{BufRead, IsTerminal};
use std::path::PathBuf;

use clap::{Args, Subcommand};
use dray_proto::{AddServer, RenameServer, Request, Response, ServerRef, ServerSummary, SetServerOn};

use super::{send, unexpected};

#[derive(Subcommand)]
pub enum ServerCommand {
    /// Add a server to the app's list. It connects before it is saved.
    #[command(after_help = "dray server add vps root@203.0.113.7
dray server add vps ssh -p 2222 root@203.0.113.7
dray server add vps my-ssh-alias
cat serve-token | dray server add vps ws://127.0.0.1:7317
dray server add --token-file serve-token vps ws://127.0.0.1:7317")]
    Add(Add),
    /// List the app's servers and whether each is connected.
    Ls(ServerLs),
    /// Take a server off the app's list, and its token with it. Its agents
    /// keep running there.
    Rm(Named),
    /// Rename a server. An empty name puts back its host.
    Rename(Rename),
    /// Connect to a server that is off, or try again now on one that failed.
    /// Waits for the attempt and says how it went.
    #[command(visible_alias = "reconnect")]
    On(Named),
    /// Stop connecting to a server. It stays on the list with its token, and
    /// its agents keep running there.
    Off(Named),
}

#[derive(Args)]
pub struct Rename {
    /// The server's name, or its id where two share a name.
    name: String,
    new_name: String,
}

#[derive(Args)]
pub struct Add {
    /// For a ws:// address, a file holding the server's token. Without it the
    /// token is read from stdin. There is no flag taking the token itself:
    /// one typed there lands in shell history and in `ps`.
    #[arg(long)]
    token_file: Option<PathBuf>,
    /// What the app calls it.
    name: String,
    /// The line you log in with (`user@host`, `ssh -p 2222 user@host`, an
    /// alias from ~/.ssh/config), or a ws:// address.
    #[arg(required = true, trailing_var_arg = true, allow_hyphen_values = true)]
    address: Vec<String>,
}

#[derive(Args)]
pub struct ServerLs {
    /// One JSON array, for reading with a program.
    #[arg(long)]
    json: bool,
}

#[derive(Args)]
pub struct Named {
    /// The server's name, or its id where two share a name.
    name: String,
}

pub fn run(command: ServerCommand) -> Result<(), String> {
    match command {
        ServerCommand::Add(args) => {
            let address = args.address.join(" ");
            // Only a URL takes a token; an SSH server's is read over the login.
            let is_url = ["ws://", "wss://", "http://", "https://"].iter().any(|s| address.starts_with(s));
            let token = match (is_url, args.token_file) {
                (false, Some(_)) => return Err("--token-file is for a ws:// address; an SSH server's token is read over the login".into()),
                (false, None) => None,
                (true, Some(path)) => {
                    Some(std::fs::read_to_string(&path).map_err(|e| format!("could not read {}: {e}", path.display()))?)
                }
                (true, None) => Some(read_token()?),
            };
            // A login can take most of a minute; say why nothing is happening.
            eprintln!("Connecting to {address}…");
            let request = Request::AddServer(AddServer { name: args.name, address, token });
            match send(request)? {
                Response::Server { server } => {
                    eprintln!("Added {} ({}). It shows in the app's server list.", server.name, server.address);
                    Ok(())
                }
                Response::Error { message } => Err(message),
                other => Err(unexpected(other)),
            }
        }
        ServerCommand::Ls(args) => match send(Request::ListServers)? {
            Response::Servers { servers } => {
                if args.json {
                    println!("{}", serde_json::to_string_pretty(&servers).unwrap_or_default());
                } else if servers.is_empty() {
                    eprintln!("No servers.");
                } else {
                    for server in &servers {
                        println!("{}", line(server));
                    }
                }
                Ok(())
            }
            Response::Error { message } => Err(message),
            other => Err(unexpected(other)),
        },
        ServerCommand::Rm(args) => {
            let server = acted_on(Request::RemoveServer(ServerRef { name: args.name }))?;
            eprintln!("Removed {}.", server.name);
            Ok(())
        }
        ServerCommand::Rename(args) => {
            let request = Request::RenameServer(RenameServer { name: args.name, new_name: args.new_name });
            eprintln!("Renamed it {}.", acted_on(request)?.name);
            Ok(())
        }
        ServerCommand::On(args) => {
            let server = acted_on(Request::SetServerOn(SetServerOn { name: args.name, on: true }))?;
            match server.status.as_str() {
                "connected" => Ok(eprintln!("{} is connected.", server.name)),
                _ => Err(format!("{} did not connect: {}", server.name, server.error.as_deref().unwrap_or(&server.status))),
            }
        }
        ServerCommand::Off(args) => {
            let server = acted_on(Request::SetServerOn(SetServerOn { name: args.name, on: false }))?;
            eprintln!("{} is off. `dray server on {}` connects it again.", server.name, server.name);
            Ok(())
        }
    }
}

fn acted_on(request: Request) -> Result<ServerSummary, String> {
    match send(request)? {
        Response::Server { server } => Ok(server),
        Response::Error { message } => Err(message),
        other => Err(unexpected(other)),
    }
}

/// One line of stdin. A terminal is asked, so the wait doesn't read as a hang.
fn read_token() -> Result<String, String> {
    let stdin = std::io::stdin();
    if stdin.is_terminal() {
        eprint!("Paste the server's token (from ~/.dray/serve-token on it), then press Enter: ");
    }
    let mut token = String::new();
    stdin.lock().read_line(&mut token).map_err(|e| format!("could not read the token: {e}"))?;
    Ok(token)
}

fn line(server: &ServerSummary) -> String {
    let mut line = format!("{}  {}  {}", server.name, server.address, server.status);
    if let Some(error) = server.error.as_deref().filter(|_| server.status != "connected") {
        line.push_str(&format!("  — {error}"));
    }
    line
}
