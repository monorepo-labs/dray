//! Speech to text, on this machine and nowhere else.
//!
//! The reader presses the mic in the composer, talks, presses it again, and the
//! words land in the draft. No audio leaves the machine and no request is made
//! while transcribing — the only network call in this module is downloading a
//! model, which is an explicit press in settings.
//!
//! Split four ways: [`catalog`] is what is on offer, [`download`] gets it onto
//! disk, [`audio`] captures and resamples, [`engine`] runs it. The whole of
//! what the frontend can do is the commands at the bottom.
//!
//! **No model ships with the app.** A recording pressed with nothing installed
//! answers [`TranscribeOutcome::NeedsModel`], which is what opens settings on
//! the transcription tab. Downloading hundreds of megabytes on a first press is
//! not a thing to do to somebody who has not asked for it.

#[path = "audio.rs"]
pub mod audio;
#[path = "catalog.rs"]
pub mod catalog;
#[path = "download.rs"]
pub mod download;
#[path = "engine.rs"]
pub mod engine;
#[path = "recordings.rs"]
pub mod recordings;

use std::path::PathBuf;

use anyhow::Result;
use serde::Serialize;
use tauri::{AppHandle, State};
use tokio::sync::Mutex;
use ts_rs::TS;

use crate::settings;
use audio::{InputDevice, Recording};
use catalog::TranscriptionModel;
use engine::Engine;

/// Everything the transcription tab draws in one read.
///
/// One command rather than three, for the reason `work_status` gives: the tab
/// must not be able to show a model as installed beside a selection that
/// disagrees with it, which is what separate reads landing out of order allow.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionStatus {
    pub models: Vec<TranscriptionModel>,
    /// Catalog ids present on disk at the right size.
    pub installed: Vec<String>,
    /// What the reader picked, which may name a model since deleted.
    pub selected_model: Option<String>,
    /// Suggested for this machine, and only a suggestion.
    pub recommended: String,
    pub devices: Vec<InputDevice>,
    /// Stored device name, or `None` for the system default.
    pub selected_device: Option<String>,
    /// False where no model is installed, or the picked one has been deleted.
    pub ready: bool,
}

/// What a stop answers with.
///
/// Every one of these is an outcome rather than an error, because the frontend
/// *acts* on each — opens settings, points at System Settings, offers a retry,
/// says nothing — where an error string could only be shown. `Failed` escaped
/// that rule for a while, and it took the recording down with it.
///
/// `NoAudio` earns its place the hard way: macOS answers a process without
/// microphone permission with a stream of **silence** rather than a refusal, so
/// the first build of this transcribed zeros to an empty string and did nothing
/// at all, which reads exactly like a broken model.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase", tag = "kind", content = "value")]
pub enum TranscribeOutcome {
    Text(String),
    /// Nothing is downloaded, or the selection names a deleted model.
    ///
    /// Carries the recording, since this is the one failure the reader can go
    /// and fix: download a model, come back, retry, and the words already spoken
    /// are still there rather than owed a second recital.
    //
    // On the variant, not the container: the container's `rename_all` names
    // *variants*, and a struct variant's fields keep their snake case without
    // this — which crosses the bridge as `audio_path` and reads as undefined.
    #[serde(rename_all = "camelCase")]
    NeedsModel { audio_path: Option<String> },
    /// The device fed nothing but zeros — permission, or a muted input.
    NoAudio,
    /// Audio arrived and the model found no words in it. Ordinary.
    Empty,
    /// The model ran and could not answer. `audio_path` is `None` only where
    /// parking the file failed too, which is the one case with nothing to retry.
    #[serde(rename_all = "camelCase")]
    Failed {
        message: String,
        audio_path: Option<String>,
    },
}

/// Recorder and loaded model, held for the process.
#[derive(Default)]
pub struct TranscriptionState {
    recording: Mutex<Option<Recording>>,
    engine: Engine,
}

/// The selected model, if one is picked *and* still on disk.
///
/// Both halves matter: a model deleted after being selected leaves the
/// selection naming nothing, and treating that as ready is what would send a
/// recording into a load that fails.
async fn ready_model() -> Option<&'static TranscriptionModel> {
    let selected = settings::read().await.transcription.model?;
    let model = catalog::find(&selected)?;

    download::is_installed(model).await.then_some(model)
}

#[tauri::command]
pub async fn transcription_status() -> Result<TranscriptionStatus, String> {
    let stored = settings::read().await.transcription;

    // A failure here is a machine with no microphone, not a broken app: the
    // tab still has models to manage, so it draws with an empty device list.
    let devices = audio::list_input_devices().unwrap_or_default();

    Ok(TranscriptionStatus {
        models: catalog::MODELS.to_vec(),
        installed: download::installed_ids().await,
        ready: ready_model().await.is_some(),
        selected_model: stored.model,
        recommended: catalog::recommended().id.to_string(),
        devices,
        selected_device: stored.device,
    })
}

/// Downloads a model, and selects it if nothing is selected yet.
///
/// Selecting is what makes one download enough to start dictating. Two things
/// it never does: replace a working choice — a reader adding a second model to
/// compare has not asked to switch to it — or select a download that was
/// called off.
#[tauri::command]
pub async fn download_transcription_model(
    app: AppHandle,
    model_id: String,
) -> Result<(), String> {
    let model = catalog::find(&model_id).ok_or_else(|| format!("unknown model \"{model_id}\""))?;

    let outcome = download::download(&app, model)
        .await
        .map_err(|e| e.to_string())?;

    // A cancel answers `Ok`, since it is what the reader asked for — but it
    // wrote no file, so selecting here would point the setting at a model that
    // is not on disk.
    if outcome == download::Downloaded::Cancelled {
        return Ok(());
    }

    // Re-read rather than checking before the download: it takes minutes, and
    // the reader may have selected something else in the meantime.
    let mut next = settings::read().await;
    if next.transcription.model.is_none() {
        next.transcription.model = Some(model.id.to_string());
        settings::write(&next).await.map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// Calls off a running download. Harmless where none is running.
#[tauri::command]
pub async fn cancel_transcription_download(model_id: String) -> Result<(), String> {
    download::cancel(&model_id);

    Ok(())
}

#[tauri::command]
pub async fn delete_transcription_model(
    state: State<'_, TranscriptionState>,
    model_id: String,
) -> Result<(), String> {
    let model = catalog::find(&model_id).ok_or_else(|| format!("unknown model \"{model_id}\""))?;

    // Before the file goes, or the copy in memory outlives the weights it was
    // read from and a deleted model keeps on transcribing.
    state.engine.unload().await;

    download::delete(model).await.map_err(|e| e.to_string())?;

    // Selecting a model that no longer exists is not a state worth keeping.
    let mut next = settings::read().await;
    if next.transcription.model.as_deref() == Some(model_id.as_str()) {
        next.transcription.model = None;
        settings::write(&next).await.map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
pub async fn select_transcription_model(
    state: State<'_, TranscriptionState>,
    model_id: Option<String>,
) -> Result<(), String> {
    if let Some(id) = &model_id {
        if catalog::find(id).is_none() {
            return Err(format!("unknown model \"{id}\""));
        }
    }

    // The next transcription loads the newly picked weights rather than running
    // the previous model's.
    state.engine.unload().await;

    let mut next = settings::read().await;
    next.transcription.model = model_id;

    settings::write(&next).await.map_err(|e| e.to_string())
}

/// Picks an input by name, or `None` for the system default.
///
/// Not validated against the live device list: the reader may be selecting a
/// mic that is currently unplugged, and [`Recording::start`] already falls back
/// to the default for one it cannot find.
#[tauri::command]
pub async fn select_transcription_device(device: Option<String>) -> Result<(), String> {
    let mut next = settings::read().await;
    next.transcription.device = device;

    settings::write(&next).await.map_err(|e| e.to_string())
}

/// Whether macOS will actually feed this process audio.
///
/// Asked *before* opening the stream, because a denied microphone yields
/// silence rather than an error and there is no later moment where the
/// difference is visible. Requesting is what raises the system prompt; the
/// answer is only used to report, since a granted-but-muted device still
/// records zeros and [`Recording::finish`] catches that case anyway.
///
/// Every non-macOS target answers `true` — there is no equivalent gate.
#[cfg(target_os = "macos")]
async fn microphone_permitted() -> bool {
    use tauri_plugin_macos_permissions::{
        check_microphone_permission, request_microphone_permission,
    };

    if check_microphone_permission().await {
        return true;
    }

    let _ = request_microphone_permission().await;

    check_microphone_permission().await
}

#[cfg(not(target_os = "macos"))]
async fn microphone_permitted() -> bool {
    true
}

/// Why a press could not start recording, or `None` where it did.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum StartRefusal {
    NeedsModel,
    NeedsPermission,
}

/// Opens the microphone.
///
/// Refuses with a reason rather than a bare `false`, since the two reasons send
/// the reader to different places — settings for a model, System Settings for
/// permission.
#[tauri::command]
pub async fn start_transcription(
    state: State<'_, TranscriptionState>,
) -> Result<Option<StartRefusal>, String> {
    if ready_model().await.is_none() {
        return Ok(Some(StartRefusal::NeedsModel));
    }

    if !microphone_permitted().await {
        return Ok(Some(StartRefusal::NeedsPermission));
    }

    let device = settings::read().await.transcription.device;
    let recording = Recording::start(device.as_deref()).map_err(|e| e.to_string())?;

    // Replaces whatever was there, which stops it: two live streams would both
    // be filling buffers and only one could ever be read.
    *state.recording.lock().await = Some(recording);

    Ok(None)
}

/// Runs the model over audio already parked on disk.
///
/// Shared by [`stop_transcription`] and [`retry_transcription`], so a retry
/// cannot drift from a first attempt — the deletion rule above all, which is the
/// one thing standing between a failed run and a lost recording.
async fn transcribe_audio(
    state: &TranscriptionState,
    audio: Vec<f32>,
    saved: Option<PathBuf>,
) -> TranscribeOutcome {
    let kept = || saved.as_ref().map(|p| p.to_string_lossy().into_owned());

    // Read after recording, not before: settings can change while the mic is
    // open, and the model that runs should be the one selected now.
    let Some(model) = ready_model().await else {
        return TranscribeOutcome::NeedsModel { audio_path: kept() };
    };

    let run = async {
        let path = download::model_path(model).await?;

        state.engine.transcribe(model.id, &path, audio).await
    };

    match run.await {
        Ok(text) => {
            // The file was insurance against this run, and the run answered. An
            // empty answer counts: the model read the audio and found no words
            // in it, which is a verdict rather than a failure.
            if let Some(path) = &saved {
                recordings::discard(path).await;
            }

            if text.is_empty() {
                TranscribeOutcome::Empty
            } else {
                TranscribeOutcome::Text(text)
            }
        }
        // `{:#}` rather than `to_string`, which prints the outermost context
        // alone — so every model failure read as the bare words "transcription
        // failed" with the cause it was wrapping thrown away.
        Err(e) => TranscribeOutcome::Failed {
            message: format!("{e:#}"),
            audio_path: kept(),
        },
    }
}

/// Stops the microphone and transcribes what was captured.
#[tauri::command]
pub async fn stop_transcription(
    state: State<'_, TranscriptionState>,
) -> Result<TranscribeOutcome, String> {
    let recording = state.recording.lock().await.take();

    // Not `Text("")`, which the frontend takes as success: it plays the closing
    // tone and appends nothing, which is the one shape every other outcome here
    // exists to prevent. Unreachable through the UI, since stop is only drawn
    // while recording — but the command is public and this is the honest answer.
    let Some(recording) = recording else {
        return Ok(TranscribeOutcome::Empty);
    };

    let Some(audio) = recording.finish().map_err(|e| e.to_string())? else {
        return Ok(TranscribeOutcome::NoAudio);
    };

    // Parked before the model is even resolved, at any length. The samples used
    // to travel into the engine by value, so a failed run took them with it and
    // the only cure left was saying the whole thing again.
    //
    // Best effort: a recording that cannot be written is worth a line in the log
    // and carrying on, since the alternative is a full disk taking down a
    // dictation that would otherwise have worked perfectly.
    let saved = match recordings::save(&audio).await {
        Ok(path) => Some(path),
        Err(e) => {
            eprintln!("[recording save err] {e:#}");
            None
        }
    };

    Ok(transcribe_audio(&state, audio, saved).await)
}

/// Runs a kept recording through the model again.
///
/// The path is the one a failing outcome handed out, and [`recordings::read`]
/// is what refuses anything outside the recordings directory — this opens a file
/// named by the frontend, so the directory is the only thing that says which
/// files it may.
#[tauri::command]
pub async fn retry_transcription(
    state: State<'_, TranscriptionState>,
    path: String,
) -> Result<TranscribeOutcome, String> {
    let path = PathBuf::from(path);
    let audio = recordings::read(&path).await.map_err(|e| format!("{e:#}"))?;

    Ok(transcribe_audio(&state, audio, Some(path)).await)
}

/// The loudest sample since this was last asked, 0.0–1.0.
///
/// Polled by the visualizer rather than pushed as an event: the bars redraw at
/// animation rate and a level is only interesting *now*, so a missed reading is
/// a dropped frame rather than lost data. `0.0` when nothing is recording.
#[tauri::command]
pub async fn transcription_level(state: State<'_, TranscriptionState>) -> Result<f32, String> {
    Ok(state
        .recording
        .lock()
        .await
        .as_ref()
        .map_or(0.0, |r| r.level()))
}

/// Drops a recording without transcribing it.
#[tauri::command]
pub async fn cancel_transcription(state: State<'_, TranscriptionState>) -> Result<(), String> {
    state.recording.lock().await.take();

    Ok(())
}
