//! The composer as the window places it: one per session, kept for the app's
//! life, so a draft and its undo survive switching away and back — what
//! useDraft's module-level store is for in the web app. Element state would
//! not do: GPUI drops it the first frame the session is off screen.

use std::collections::HashMap;
use std::rc::Rc;

use gpui::{AnyElement, App, AppContext as _, Entity, Global, IntoElement, Subscription, Window};

use super::{Composer, ComposerEvent};

type Handler = Rc<dyn Fn(&str, &ComposerEvent, &mut Window, &mut App)>;

#[derive(Default)]
struct Composers {
    by_session: HashMap<String, (Entity<Composer>, Subscription)>,
    handler: Option<Handler>,
}

impl Global for Composers {}

/// Where every composer's events go, with the session they came from: `Send`
/// is `send_msg`, `Stop` is `interrupt`, `Query` refreshes that composer's rows.
pub fn on_event(cx: &mut App, handler: impl Fn(&str, &ComposerEvent, &mut Window, &mut App) + 'static) {
    cx.default_global::<Composers>().handler = Some(Rc::new(handler));
}

/// The session's composer, made on first ask.
pub fn for_session(session_id: &str, window: &mut Window, cx: &mut App) -> Entity<Composer> {
    if let Some((composer, _)) = cx.default_global::<Composers>().by_session.get(session_id) {
        return composer.clone();
    }
    let composer = cx.new(|cx| Composer::new(window, cx));
    let id = session_id.to_string();
    let subscription = window.subscribe(&composer, cx, move |_, event: &ComposerEvent, window, cx| {
        if let Some(handler) = cx.global::<Composers>().handler.clone() {
            handler(&id, event, window, cx);
        }
    });
    cx.global_mut::<Composers>().by_session.insert(session_id.to_string(), (composer.clone(), subscription));
    composer
}

/// What the window's composer slot draws.
pub fn slot(session_id: &str, window: &mut Window, cx: &mut App) -> AnyElement {
    for_session(session_id, window, cx).into_any_element()
}

/// Drops a deleted session's composer and its draft.
pub fn forget(session_id: &str, cx: &mut App) {
    cx.default_global::<Composers>().by_session.remove(session_id);
}
