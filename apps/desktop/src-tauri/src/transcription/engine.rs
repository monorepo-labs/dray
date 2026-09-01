//! Loading a model and running audio through it.
//!
//! The engine is [`transcribe-cpp`](https://crates.io/crates/transcribe-cpp) —
//! MIT, by CJ Pais, and the same one [Handy](https://github.com/cjpais/Handy)
//! runs on. It covers the whole GGUF family behind one type, so Whisper,
//! Parakeet and Canary all load through the same call and this module needs no
//! per-architecture branch.
//!
//! **The backend is a build-time choice, not a runtime one.** `Cargo.toml`
//! turns the `metal` feature on for macOS and off elsewhere, so `Backend::Auto`
//! resolves to the GPU on Apple Silicon and to CPU on every other target.
//! Nothing here can change that, which is why there is no accelerator setting.

use std::path::Path;

use anyhow::{Context, Result};
use tokio::sync::Mutex;
use transcribe_cpp::{Model, ModelOptions, RunOptions, Session};

/// A loaded model, kept between dictations.
///
/// Loading is seconds and hundreds of megabytes, so a session dropped after
/// every recording would put that cost on every press. The id rides along
/// because the reader can switch models in settings while one is loaded, and
/// the *only* way to notice is to compare against what was asked for.
#[derive(Default)]
pub struct Engine {
    loaded: Mutex<Option<Loaded>>,
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

    /// Drops the loaded model.
    ///
    /// Called when the reader deletes or switches models, so the weights on
    /// disk and the ones in memory cannot disagree — and so a delete actually
    /// frees the memory rather than only the file.
    pub async fn unload(&self) {
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

    #[tokio::test]
    async fn unload_on_an_empty_engine_is_fine() {
        Engine::default().unload().await;
    }
}
