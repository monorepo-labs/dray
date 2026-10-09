//! Where the core's events go: the desktop's webview, or every client of a
//! `dray-serve`. The one thing the core used `AppHandle` for, so it is the one
//! seam between the core and Tauri. See SERVE-PLAN.md.

use std::sync::Arc;

/// A handle the core emits events through. Cheap to clone, like the
/// `AppHandle` it replaced, and `emit` is spelled the same so no call site
/// had to change.
#[derive(Clone)]
pub struct Sink(Arc<dyn Fn(&str, serde_json::Value) + Send + Sync>);

impl Sink {
    pub fn new(emit: impl Fn(&str, serde_json::Value) + Send + Sync + 'static) -> Self {
        Self(Arc::new(emit))
    }

    /// Fails only where the payload will not serialize, which Tauri's own
    /// `emit` reported the same way.
    pub fn emit<S: serde::Serialize>(&self, event: &str, payload: S) -> anyhow::Result<()> {
        (self.0)(event, serde_json::to_value(payload)?);
        Ok(())
    }
}

impl std::fmt::Debug for Sink {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Sink")
    }
}

#[cfg(feature = "desktop")]
impl<R: tauri::Runtime> From<&tauri::AppHandle<R>> for Sink {
    fn from(app: &tauri::AppHandle<R>) -> Self {
        use tauri::Emitter;
        let app = app.clone();
        Self::new(move |event, payload| {
            // Into the hub too, for Remote access's clients — except this
            // Mac's own servers and Remote access itself, which are news to
            // this window alone.
            if !matches!(
                event,
                "servers_changed" | "server_event" | "server_adding" | "server_installing" | "remote_access_changed"
            ) {
                crate::serve::HUB.publish(event, &payload);
            }
            if let Err(e) = app.emit(event, payload) {
                eprintln!("[emit err] {event}: {e}");
            }
        })
    }
}

/// Lets a Tauri command take `sink: Sink` exactly as it took `app: AppHandle`,
/// which is what keeps a command's body the same Rust in both builds.
#[cfg(feature = "desktop")]
impl<'de, R: tauri::Runtime> tauri::ipc::CommandArg<'de, R> for Sink {
    fn from_command(
        command: tauri::ipc::CommandItem<'de, R>,
    ) -> Result<Self, tauri::ipc::InvokeError> {
        use tauri::Manager;
        Ok(Self::from(command.message.webview().app_handle()))
    }
}
