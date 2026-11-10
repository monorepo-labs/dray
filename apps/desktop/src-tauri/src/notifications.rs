use tauri::{AppHandle, Emitter, Manager};

/// Show a desktop notification that clicks back into the session it came from.
///
/// Deliberately not `tauri-plugin-notification`, for two reasons that each rule
/// it out on their own. It drops the handle `show` returns, and that handle is
/// the only thing a click is reported through. And it posts through
/// `NSUserNotificationCenter`, which current macOS does not deliver for an app
/// at all — see `apps/desktop/docs/notifications.md` for what was measured.
///
/// Waiting on the handle blocks until the reader acts or the banner times out,
/// hence `spawn_blocking`: one parked thread per banner, and the timeout is the
/// only thing bounding it — without one the wait polls forever (#458).
#[tauri::command]
pub async fn notify_session(
    app: AppHandle,
    session_id: String,
    kind: String,
    title: String,
    body: String,
) -> Result<(), String> {
    // `UNUserNotificationCenter` reaches for the running process's bundle and
    // raises an **uncaught** `NSInternalInconsistencyException` when there
    // isn't one — not an error it returns, an abort that takes the app with it.
    // A `tauri dev` binary is exactly that case: it runs from `target/debug`
    // rather than a `.app`, so it has no bundle to find. Hence the early return,
    // and hence no desktop banners while developing; the in-app notice and the
    // sidebar rail are the whole signal there.
    //
    // `notify_rust::check_bundle` is *not* the guard to use. It only asks
    // whether a bundle identifier exists, which an embedded `Info.plist` is
    // enough to satisfy — it answered `Ok` for the dev binary right up to the
    // frame that crashed it.
    #[cfg(target_os = "macos")]
    if tauri::is_dev() {
        return Ok(());
    }

    #[cfg(target_os = "linux")]
    {
        let _ = kind;
        return linux::notify(app, session_id, title, body).await;
    }

    #[cfg(not(target_os = "linux"))]
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "macos")]
        request_auth_once();

        let mut notification = notify_rust::Notification::new();
        // A banner is there to be clicked now; after a minute it is taken out of
        // Notification Center and the wait ends — the in-app notice and the rail
        // carry the signal from there.
        notification
            .summary(&title)
            .body(&body)
            .auto_icon()
            .timeout(notify_rust::Timeout::Milliseconds(BANNER_MS));

        #[cfg(target_os = "macos")]
        notification.sound_name(sound_for(&kind));

        let handle = match notification.show() {
            Ok(handle) => handle,
            // Best-effort by design: the in-app notice and the sidebar rail both
            // survive this, so a failure must never reach the reader as an error.
            Err(e) => return eprintln!("[notify err] {e}"),
        };

        #[cfg(target_os = "macos")]
        handle.wait_for_action(|action| {
            // Only a tap on the body asks to look. A dismissal is `"__closed"`
            // but the timeout's expiry is `""`, so `!= "__closed"` would raise
            // the window on every banner that timed out.
            if action == "default" {
                activate(&app, &session_id);
            }
        });
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (handle, &app, &session_id, &kind);
        }
    });

    #[cfg(not(target_os = "linux"))]
    Ok(())
}

/// How long a banner stays up, and so how long its click is waited on.
const BANNER_MS: u32 = 60_000;

/// Marks the window urgent, Linux's nearest thing to the Mac's dock badge:
/// the taskbar or dock highlights it until it is cleared. A no-op elsewhere.
///
/// Skipped on GNOME, whose shell answers an urgent window with a "Dray is
/// ready" banner of its own — a second banner for an event that already
/// posted one.
#[tauri::command]
pub fn set_window_urgent(app: AppHandle, urgent: bool) {
    #[cfg(target_os = "linux")]
    {
        let gnome = std::env::var("XDG_CURRENT_DESKTOP")
            .is_ok_and(|d| d.split(':').any(|d| d.eq_ignore_ascii_case("gnome")));
        if urgent && gnome {
            return;
        }
        if let Some(window) = app.get_webview_window("main") {
            let kind = urgent.then_some(tauri::UserAttentionType::Informational);
            let _ = window.request_user_attention(kind);
        }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = (app, urgent);
}

#[cfg(target_os = "linux")]
mod linux {
    use futures_util::StreamExt;
    use tauri::AppHandle;

    const BUS_NAME: &str = "org.freedesktop.Notifications";
    const PATH: &str = "/org/freedesktop/Notifications";

    /// Posts the banner and waits on its click over D-Bus, on a task.
    ///
    /// Not notify-rust's `wait_for_action`: that waits until the server
    /// reports the banner closed, and GNOME keeps an expired banner in its
    /// tray without saying so, so the wait would never end. This one ends at
    /// the banner's own timeout and takes the banner down with it, as the
    /// Mac's does, so a late click cannot land on nothing.
    ///
    /// Silent on purpose: the window plays the app's own clip beside it
    /// (`notify.ts`), where a server's default sound is one every app makes.
    pub async fn notify(
        app: AppHandle,
        session_id: String,
        title: String,
        body: String,
    ) -> Result<(), String> {
        let mut notification = notify_rust::Notification::new();
        match icon() {
            Some(path) => notification.icon(path),
            None => notification.auto_icon(),
        };
        notification
            .appname("Dray")
            .summary(&title)
            .body(&body)
            // The spec's key for a click on the body. GNOME, KDE and dunst
            // take it there; xfce draws it as a button, hence the label.
            .action("default", "Open")
            .hint(notify_rust::Hint::SuppressSound(true))
            .timeout(notify_rust::Timeout::Milliseconds(super::BANNER_MS));
        // Listening before posting, so no click can land between the two. A
        // failed listen still posts: the banner is worth showing unclickable.
        let signals = listen().await.inspect_err(|e| eprintln!("[notify listen err] {e}")).ok();
        let id = notification.show_async().await.map_err(|e| e.to_string())?.id();
        let Some(signals) = signals else { return Ok(()) };

        tauri::async_runtime::spawn(async move {
            let wait = std::time::Duration::from_millis(super::BANNER_MS.into());
            match tokio::time::timeout(wait, clicked(signals, id)).await {
                Ok(true) => super::activate(&app, &session_id),
                Ok(false) => {}
                Err(_) => close(id).await,
            }
        });
        Ok(())
    }

    /// Every signal the notification server sends, in order. One stream for
    /// both signals, never one each: a click is sent with the close right
    /// behind it, and two streams raced in a `select!` read the close first
    /// about half the time, losing the click.
    async fn listen() -> zbus::Result<zbus::proxy::SignalStream<'static>> {
        let conn = zbus::Connection::session().await?;
        let proxy = zbus::Proxy::new(&conn, BUS_NAME, PATH, BUS_NAME).await?;
        proxy.receive_all_signals().await
    }

    /// Whether banner `id` was clicked, answered once it is clicked or closed.
    async fn clicked(mut signals: zbus::proxy::SignalStream<'static>, id: u32) -> bool {
        while let Some(msg) = signals.next().await {
            let header = msg.header();
            match header.member().map(|m| m.as_str()) {
                Some("ActionInvoked") => {
                    if let Ok((nid, key)) = msg.body().deserialize::<(u32, String)>() {
                        if nid == id {
                            return key == "default";
                        }
                    }
                }
                Some("NotificationClosed") => {
                    if msg.body().deserialize::<(u32, u32)>().is_ok_and(|(nid, _)| nid == id) {
                        return false;
                    }
                }
                _ => {}
            }
        }
        false
    }

    /// The app's icon as a file, written once a process. A banner names its
    /// icon by theme name or path, and nothing installs Dray into an icon
    /// theme — an AppImage installs nothing at all — so the name drew a
    /// broken image.
    fn icon() -> Option<&'static str> {
        static ICON: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
        ICON.get_or_init(|| {
            let (name, bytes): (_, &[u8]) = if tauri::is_dev() {
                ("icon-dev.png", include_bytes!("../icons/dev/128x128.png"))
            } else {
                ("icon.png", include_bytes!("../icons/128x128.png"))
            };
            let cache = std::env::var_os("XDG_CACHE_HOME")
                .filter(|d| !d.is_empty())
                .map(std::path::PathBuf::from)
                .or_else(|| std::env::home_dir().map(|h| h.join(".cache")))?;
            let path = cache.join("dray").join(name);
            std::fs::create_dir_all(path.parent()?).ok()?;
            std::fs::write(&path, bytes).ok()?;
            path.into_os_string().into_string().ok()
        })
        .as_deref()
    }

    async fn close(id: u32) {
        let Ok(conn) = zbus::Connection::session().await else { return };
        let _ = conn
            .call_method(Some(BUS_NAME), PATH, Some(BUS_NAME), "CloseNotification", &(id,))
            .await;
    }
}

/// Pick the banner's sound from what the session wants.
///
/// A banner with no sound at all is delivered silently — notify-rust only calls
/// `setSound` when a name is set — and silence is worst on exactly this channel,
/// which fires when the reader is in another app and can neither see the in-app
/// notice nor hear the sound it plays.
///
/// The two kinds are told apart because only one of them is a request: a
/// question left unanswered holds the session open, so it gets a sound that
/// stands out from the OS default the reader hears all day. `""` reads like "no
/// sound" and is the opposite — it is the name `UNNotificationSound.soundNamed:`
/// resolves to the system default, verified by ear against a named one.
#[cfg(target_os = "macos")]
fn sound_for(kind: &str) -> &'static str {
    match kind {
        "asking" => "Ping",
        _ => "",
    }
}

/// Ask the OS for permission, once for the life of the process.
///
/// The first call is what raises the system prompt, and it **blocks until the
/// reader answers it** — so this must not be per-banner, or a stack of parked
/// threads all waits on one dialog. Posting before the answer lands is refused
/// outright, which is why the ask is here rather than at startup: it is the
/// first notification that needs it, and asking then is also what puts the
/// dialog in front of someone who has just seen why the app wants it.
///
/// A denial is silent and permanent. Nothing branches on the result because
/// there is nothing useful to do with it — a refused post already logs, and the
/// in-app notice covers the reader either way.
#[cfg(target_os = "macos")]
fn request_auth_once() {
    static ASKED: std::sync::Once = std::sync::Once::new();
    ASKED.call_once(|| {
        if let Err(e) = notify_rust::request_auth_blocking() {
            eprintln!("[notify auth err] {e}");
        }
    });
}

/// Bring the window forward and tell the frontend which session was asked for.
///
/// Both halves are needed and neither implies the other: the OS raises the app
/// on its own, but nothing about being frontmost selects a session.
/// Also the Island's way into a session, through the server's `show_session`.
pub fn activate(app: &AppHandle, session_id: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    if let Err(e) = app.emit("notification_activated", session_id) {
        eprintln!("[notify emit err] {e}");
    }
}
