//! Loading a model and running audio through it.
//!
//! The engine is [`transcribe-cpp`](https://github.com/handy-computer/transcribe.cpp)
//! — MIT, `Copyright (c) 2026 The transcribe.cpp authors`. Its own repository
//! and its own notice, published separately from the
//! [Handy](https://github.com/cjpais/Handy) app that made it; crediting it to
//! Handy names the wrong holder. It covers the whole GGUF family behind one
//! type, so Whisper,
//! Parakeet and Canary all load through the same call and this module needs no
//! per-architecture branch.
//!
//! **The backend is a build-time choice, not a runtime one.** `Cargo.toml`
//! turns the `metal` feature on for macOS and off elsewhere, so `Backend::Auto`
//! resolves to the GPU on Apple Silicon and to CPU on every other target.
//! Nothing here can change that, which is why there is no accelerator setting.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use anyhow::{Context, Result};
use tokio::sync::Mutex;
use transcribe_cpp::{Model, ModelOptions, RunOptions, Session};

/// A loaded model, kept between dictations.
///
/// Loading is seconds and hundreds of megabytes, so a session dropped after
/// every recording would put that cost on every press. The id rides along
/// because the reader can switch models in settings while one is loaded, and
/// the *only* way to notice is to compare against what was asked for.
///
/// Cloneable, so [`Engine::warm`] can be spawned off a command that only
/// borrows the managed state.
#[derive(Default, Clone)]
pub struct Engine {
    loaded: Arc<Mutex<Option<Loaded>>>,
    /// Bumped by every [`Engine::unload`], so a warm that started before one
    /// can tell its answer is stale. Without it a load begun at launch lands
    /// after a switch or a delete and installs a model the reader is done
    /// with — for a delete, one whose weights are no longer on disk.
    generation: Arc<AtomicU64>,
}

struct Loaded {
    model_id: String,
    session: Session,
}

impl Engine {
    /// Transcribes 16kHz mono audio, loading the model first if it is not
    /// already the one in hand.
    ///
    /// Everything native runs under one `Mutex` and on a blocking thread:
    /// `Session::run` is a synchronous C++ call that occupies a core for the
    /// length of the audio, and two of them at once on one model is what the
    /// crate's own per-model run lock exists to prevent.
    pub async fn transcribe(&self, model_id: &str, path: &Path, audio: Vec<f32>) -> Result<String> {
        // Silence still costs a full model load and run, and answers with
        // nothing or a hallucinated word — worth refusing before either.
        if audio.len() < super::audio::TARGET_RATE as usize / 4 {
            return Ok(String::new());
        }

        let mut guard = self.loaded.lock().await;

        if guard.as_ref().is_none_or(|l| l.model_id != model_id) {
            *guard = Some(Loaded {
                model_id: model_id.to_string(),
                session: load(path).await?,
            });
        }

        // Moved onto the blocking thread and handed back, rather than borrowed:
        // `Session::run` needs `&mut`, and the guard cannot cross into
        // `spawn_blocking` with it.
        let mut loaded = guard.take().expect("just loaded");

        let (loaded, result) = tokio::task::spawn_blocking(move || {
            let result = loaded
                .session
                .run(&audio, &RunOptions::default())
                .map(|t| t.text)
                .context("transcription failed");

            (loaded, result)
        })
        .await
        .context("the transcription thread panicked")?;

        // Put the model back whatever the run did: a failed run leaves it
        // perfectly usable, and dropping it here would reload hundreds of
        // megabytes on the next press for nothing. A *panic* is the exception —
        // `?` above leaves the slot empty, which reloads.
        *guard = Some(loaded);

        Ok(result?.trim().to_string())
    }

    /// Loads the model now, so a dictation started this second doesn't pay for
    /// it when it ends.
    ///
    /// The first load is seconds where every later one is free, which is felt
    /// as the *first* dictation being slow and the rest instant. Called when
    /// recording starts: the reader is talking for that whole window, so the
    /// load lands before they press stop. Failures are silent — the real
    /// transcribe loads again and reports for itself.
    pub async fn warm(&self, model_id: String, path: PathBuf) {
        let generation = self.generation.load(Ordering::SeqCst);

        if self
            .loaded
            .lock()
            .await
            .as_ref()
            .is_some_and(|l| l.model_id == model_id)
        {
            return;
        }

        // Loaded with the lock *released*: holding it across seconds of load
        // is what would make a switch or delete waiting in `unload` block for
        // the whole of it.
        let session = match load(&path).await {
            Ok(session) => session,
            Err(e) => {
                eprintln!("could not warm the transcription model: {e:#}");
                return;
            }
        };

        let mut guard = self.loaded.lock().await;

        // Re-read under the lock: an unload landing while this loaded means
        // the model is one the reader has switched away from or deleted.
        if self.generation.load(Ordering::SeqCst) == generation {
            *guard = Some(Loaded { model_id, session });
        }
    }

    /// Drops the loaded model.
    ///
    /// Called when the reader deletes or switches models, so the weights on
    /// disk and the ones in memory cannot disagree — and so a delete actually
    /// frees the memory rather than only the file.
    pub async fn unload(&self) {
        // Before the lock, not after: a warm already waiting on it must see
        // the new generation and drop what it loaded rather than installing
        // it over the clear this is about to make.
        self.generation.fetch_add(1, Ordering::SeqCst);

        *self.loaded.lock().await = None;
    }
}

async fn load(path: &Path) -> Result<Session> {
    let path = path.to_path_buf();

    tokio::task::spawn_blocking(move || {
        let model = Model::load_with(&path, &ModelOptions::default())
            .context("could not load the transcription model")?;

        model.session().context("could not start a model session")
    })
    .await
    .context("the model loader panicked")?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// No model is downloaded in CI, so the reachable assertion is the guard
    /// ahead of the load: a tap on the mic button must cost nothing.
    #[tokio::test]
    async fn audio_shorter_than_a_quarter_second_is_not_transcribed() {
        let engine = Engine::default();
        let audio = vec![0.0; 1000];

        let text = engine
            .transcribe("whisper-small", Path::new("/nonexistent"), audio)
            .await
            .unwrap();

        assert!(text.is_empty());
    }

    /// A warm that cannot load must leave the engine exactly as it found it,
    /// since the transcribe behind it is the one that reports the failure.
    #[tokio::test]
    async fn a_failed_warm_loads_nothing_and_does_not_panic() {
        let engine = Engine::default();

        engine
            .warm("whisper-small".into(), PathBuf::from("/nonexistent"))
            .await;

        assert!(engine.loaded.lock().await.is_none());
    }

    #[tokio::test]
    async fn unload_on_an_empty_engine_is_fine() {
        Engine::default().unload().await;
    }

    /// The rule a stale warm is rejected by. Reachable with no weights on disk
    /// because it is the counter, not the load, that decides.
    #[tokio::test]
    async fn unload_moves_the_generation_a_warm_is_judged_against() {
        let engine = Engine::default();
        let before = engine.generation.load(Ordering::SeqCst);

        engine.unload().await;

        assert_ne!(engine.generation.load(Ordering::SeqCst), before);
    }
}
