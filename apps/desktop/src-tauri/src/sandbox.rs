//! Sandboxes that stop on a timer, whichever provider runs them. `servers.rs`
//! decides what to do with a sandbox's state; this is the one place that knows
//! which provider to ask. See docs/sandboxes.md.

use crate::machines::{BoatLink, VercelLink};
use chrono::{DateTime, Utc};
use serde::Serialize;
use std::time::Duration;
use ts_rs::TS;

/// A saved machine's sandbox.
#[derive(Debug, Clone, PartialEq)]
pub enum Link {
    Boat(BoatLink),
    Vercel(VercelLink),
}

/// Who runs a sandbox, for the words the UI says about it.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "snake_case")]
pub enum SandboxProvider {
    Boat,
    Vercel,
}

impl SandboxProvider {
    /// Its name in analytics, where boat's events predate the rest.
    pub fn tag(self) -> &'static str {
        match self {
            SandboxProvider::Boat => "boat",
            SandboxProvider::Vercel => "vercel",
        }
    }
}

/// What a provider says about a sandbox.
#[derive(Debug, Clone, PartialEq)]
pub struct Sandbox {
    pub stopped: bool,
    /// Where SSH reaches it, while it has a machine at all. Boat's alone: a
    /// Vercel sandbox is reached by its server's own address.
    pub endpoint: Option<String>,
    pub stops_at: Option<DateTime<Utc>>,
}

impl Link {
    pub fn provider(&self) -> SandboxProvider {
        match self {
            Link::Boat(_) => SandboxProvider::Boat,
            Link::Vercel(_) => SandboxProvider::Vercel,
        }
    }

    /// The sandbox's state, or `None` for anything else: no CLI, logged out,
    /// offline, a sandbox this login cannot see. All of those mean no UI.
    pub async fn info(&self) -> Option<Sandbox> {
        match self {
            Link::Boat(link) => crate::boat::info(&link.id).await,
            Link::Vercel(link) => crate::vercel::info(link).await,
        }
    }

    /// Brings a stopped sandbox back. Returns before Dray is up on it.
    pub async fn resume(&self) -> Result<(), String> {
        match self {
            Link::Boat(link) => crate::boat::resume(&link.id).await,
            Link::Vercel(link) => crate::vercel::resume(link).await,
        }
    }

    /// Sets the time left to `minutes`. Never adds: boat's `--ttl` sets, and
    /// the card, the island and auto-extend all read it that way.
    pub async fn extend(&self, minutes: u32) -> Result<(), String> {
        match self {
            Link::Boat(link) => crate::boat::extend(&link.id, minutes).await,
            Link::Vercel(link) => crate::vercel::extend(link, minutes).await,
        }
    }

    /// The longest a resume can take before the row gives up on it.
    pub fn resuming(&self) -> Duration {
        match self {
            Link::Boat(_) => crate::boat::RESUMING,
            Link::Vercel(_) => crate::vercel::RESUMING,
        }
    }
}
