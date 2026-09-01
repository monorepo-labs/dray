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
/// Three of these are outcomes rather than errors because the frontend *acts*
/// on each — opens settings, points at System Settings, says nothing — where an
/// error string could only be shown.
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
    NeedsModel,
    /// The device fed nothing but zeros — permission, or a muted input.
    NoAudio,
    /// Audio arrived and the model found no words in it. Ordinary.
    Empty,
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

    // Read after recording, not before: settings can change while the mic is
    // open, and the model that runs should be the one selected now.
    let Some(model) = ready_model().await else {
        return Ok(TranscribeOutcome::NeedsModel);
    };

    let path = download::model_path(model).await.map_err(|e| e.to_string())?;

    let text = state
        .engine
        .transcribe(model.id, &path, audio)
        .await
        .map_err(|e| e.to_string())?;

    if text.is_empty() {
        return Ok(TranscribeOutcome::Empty);
    }

    Ok(TranscribeOutcome::Text(text))
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
