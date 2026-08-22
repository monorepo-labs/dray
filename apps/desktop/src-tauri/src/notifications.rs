use tauri::{AppHandle, Emitter, Manager};

/// Show a desktop notification that clicks back into the session it came from.
///
/// Deliberately not `tauri-plugin-notification`, for two reasons that each rule
/// it out on their own. It drops the handle `show` returns, and that handle is
/// the only thing a click is reported through. And it posts through
/// `NSUserNotificationCenter`, which current macOS does not deliver for an app
/// at all — see the notifications section of CLAUDE.md for what was measured.
///
/// Waiting on the handle blocks until the reader acts or the banner ages out,
/// hence `spawn_blocking`: one parked thread per banner on screen, bounded by
/// how many the OS will stack.
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

    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "macos")]
        request_auth_once();

        let mut notification = notify_rust::Notification::new();
        notification.summary(&title).body(&body).auto_icon();

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
            // A tap on the banner body is `"default"`; a dismissal or an expiry
            // is `"__closed"`, which is the reader declining to look — raising
            // the window on that would be the opposite of what was asked.
            if action != "__closed" {
                activate(&app, &session_id);
            }
        });
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (handle, &app, &session_id, &kind);
        }
    });

    Ok(())
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
#[cfg(target_os = "macos")]
fn activate(app: &AppHandle, session_id: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    if let Err(e) = app.emit("notification_activated", session_id) {
        eprintln!("[notify emit err] {e}");
    }
}
