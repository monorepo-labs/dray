package com.yogesh.dray.voice

import android.content.Context
import android.media.MediaActionSound
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.yogesh.dray.model.SessionKey
import com.yogesh.dray.net.ConnState
import com.yogesh.dray.net.http
import com.yogesh.dray.store.Store
import com.yogesh.dray.ui.sentence
import com.yogesh.dray.wire.DrayError
import com.yogesh.dray.wire.get
import com.yogesh.dray.wire.jsonOf
import com.yogesh.dray.wire.str
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import java.io.File
import java.util.UUID
import kotlin.math.log10

/** Where a dictation is, which is what the orb draws. */
enum class Dictation { Idle, Starting, Recording, Transcribing }

/** `transcription.rs`'s `TranscribeOutcome`. An unknown kind reads as a failure naming it. */
sealed interface TranscribeOutcome {
    data class Text(val words: String) : TranscribeOutcome
    data object NeedsModel : TranscribeOutcome
    data object NoAudio : TranscribeOutcome
    data object Empty : TranscribeOutcome
    data class Failed(val message: String) : TranscribeOutcome

    companion object {
        fun decode(e: JsonElement): TranscribeOutcome = when (val kind = e["kind"].str) {
            "text" -> Text(e["value"].str.orEmpty())
            "needsModel" -> NeedsModel
            "noAudio" -> NoAudio
            "empty" -> Empty
            "failed" -> Failed(e["value"]["message"].str ?: "The server couldn't transcribe")
            else -> Failed("The server answered $kind")
        }
    }
}

/** What turns the phone's voice into words: Android's recognizer on the phone, or a server's model. */
sealed interface DictationEngine {
    data object Phone : DictationEngine
    data class Server(val id: String) : DictationEngine
}

fun Store.canDictate(server: String): Boolean =
    serverState[server] == ConnState.Connected && connection(server)?.welcome?.dictation == true

fun Store.canDictate(engine: DictationEngine): Boolean = when (engine) {
    DictationEngine.Phone -> Dictations.phoneUsable
    is DictationEngine.Server -> canDictate(engine.id)
}

/**
 * Nothing can transcribe, so the docks offer the keyboard alone. Read off each server's last
 * welcome, kept across a drop, so a blip never swaps the dock mid-reply; one not yet reached counts as able.
 */
val Store.typesOnly: Boolean
    get() = !Dictations.phoneUsable && live.none { s -> connection(s.id)?.welcome?.let { it.dictation == true } ?: true }

/**
 * Settings' pick while it can; otherwise the first server that can, then the phone's recognizer.
 * Words come back to the phone, so any session's draft can take them.
 */
fun Store.dictationEngine(pick: String = Dictations.pick): DictationEngine? {
    if (pick == PhoneSpeech.PICK && Dictations.phoneUsable) return DictationEngine.Phone
    if (pick.isNotEmpty() && canDictate(pick)) return DictationEngine.Server(pick)
    servers.firstOrNull { canDictate(it.id) }?.let { return DictationEngine.Server(it.id) }
    return if (Dictations.phoneUsable) DictationEngine.Phone else null
}

fun Store.name(of: DictationEngine): String = when (of) {
    DictationEngine.Phone -> "This phone"
    is DictationEngine.Server -> name(of.id)
}

/** `appendToDraft`'s join: a space unless the draft is empty or already ends in one. */
fun Store.appendToDraft(key: SessionKey, text: String) {
    val draft = drafts[key].orEmpty()
    drafts[key] = if (draft.isEmpty() || draft.last().isWhitespace()) draft + text else "$draft $text"
}

/** Uploads a recording and has the server's model read it. A long dictation on a model loading cold can outlast a minute. */
suspend fun Store.transcribe(server: String, wav: File): TranscribeOutcome {
    val c = connection(server) ?: throw DrayError("Not connected")
    val base = c.httpBase?.toHttpUrlOrNull() ?: throw DrayError("Not an address: ${c.url}")
    val url = base.newBuilder().addPathSegment("upload").addQueryParameter("name", "dictation.wav")
        .apply { c.via?.let { addQueryParameter("via", it) } }.build()
    val path = withContext(Dispatchers.IO) {
        val request = Request.Builder().url(url).header("Authorization", "Bearer ${c.token}")
            .post(wav.asRequestBody("audio/wav".toMediaType())).build()
        http.newCall(request).execute().use { r ->
            if (r.code != 200) throw DrayError("The upload was refused (${r.code})")
            r.body?.string().orEmpty()
        }
    }
    return TranscribeOutcome.decode(call(server, "transcribe_upload", jsonOf("path" to path), timeoutMs = 300_000))
}

/** A raw sample peak as 0…1 on a decibel scale: a quiet room reads as nothing, ordinary speech fills most of it. */
fun loudness(peak: Float): Float {
    val db = 20 * log10(maxOf(peak.toDouble(), 1e-6))
    return ((db + 50) / 32).coerceIn(0.0, 1.0).toFloat()
}

/**
 * Every dictation, per draft, outliving the dock that started it: a recording stopped on leaving
 * a session answers into a screen that is gone, and its words, its sentence or its kept file must
 * still be there on the way back. Dictation.swift's `Dictations`. Touched on the main thread only.
 */
object Dictations {
    /** Settings, Dictation's "Start and stop sounds". */
    const val SOUNDS_KEY = "dictation.sounds"
    /** A server's id, or `PhoneSpeech.PICK`. Named for when servers were the only engine. */
    const val ENGINE_KEY = "dictation.server"

    private lateinit var app: Context
    private val prefs by lazy { app.getSharedPreferences("settings", Context.MODE_PRIVATE) }
    private val sound by lazy { MediaActionSound() }

    private val phase = mutableStateMapOf<SessionKey, Dictation>()
    val since = mutableStateMapOf<SessionKey, Long>()
    val notes = mutableStateMapOf<SessionKey, String>()
    /** A recording the server never answered for, kept for Retry: the only copy of the speech. */
    val kept = mutableStateMapOf<SessionKey, File>()
    /** What reads each draft's recording, taken at the press. */
    private val engines = mutableMapOf<SessionKey, DictationEngine>()
    private val recorders = mutableMapOf<SessionKey, WavRecorder>()
    private val listeners = mutableMapOf<SessionKey, PhoneSpeech.Run>()
    /** The transcription each draft waits on. Cancel clears it, so an answer landing after is dropped rather than written in. */
    private val pending = mutableMapOf<SessionKey, String>()

    var pick by mutableStateOf("")
        private set
    var sounds by mutableStateOf(true)
        private set
    /** Read at launch and on Settings' page, since a language pack can come down in between. */
    var phoneUsable by mutableStateOf(false)
        private set

    fun start(context: Context) {
        app = context.applicationContext
        pick = prefs.getString(ENGINE_KEY, "").orEmpty()
        sounds = prefs.getBoolean(SOUNDS_KEY, true)
        refreshPhone()
    }

    fun refreshPhone() { phoneUsable = PhoneSpeech.usable(app) }

    fun choose(engine: String) {
        pick = engine
        prefs.edit().putString(ENGINE_KEY, engine).apply()
    }

    fun playSounds(on: Boolean) {
        sounds = on
        prefs.edit().putBoolean(SOUNDS_KEY, on).apply()
    }

    fun state(draft: SessionKey): Dictation = phase[draft] ?: Dictation.Idle

    /** The voice, 0…1, as the orb reads it; polled each frame. */
    fun level(draft: SessionKey): Float =
        recorders[draft]?.let { loudness(it.takePeak()) } ?: listeners[draft]?.level ?: 0f

    /** Starts listening into `draft`. The dock has the microphone's permission before it calls this. */
    fun start(store: Store, engine: DictationEngine, draft: SessionKey) {
        if (state(draft) != Dictation.Idle || kept[draft] != null) return
        // One microphone: a recording into another draft stops first, its words kept there.
        for (other in phase.filterValues { it == Dictation.Recording }.keys) if (other != draft) stop(store, other)
        phase[draft] = Dictation.Starting
        notes.remove(draft)
        if (sounds) sound.play(MediaActionSound.START_VIDEO_RECORDING)
        try {
            when (engine) {
                DictationEngine.Phone -> {
                    val run = PhoneSpeech.Run(app)
                    listeners[draft] = run
                    run.start()
                    // A recognizer that gives up on its own ends the recording, and says why.
                    store.scope.launch {
                        run.awaitEnd()
                        if (listeners[draft] === run && state(draft) == Dictation.Recording) stop(store, draft)
                    }
                }
                is DictationEngine.Server -> {
                    val r = WavRecorder(File(app.cacheDir, "dictation-${UUID.randomUUID()}.wav"))
                    if (!r.start()) {
                        r.discard()
                        throw DrayError("The microphone would not start")
                    }
                    recorders[draft] = r
                }
            }
            engines[draft] = engine
            since[draft] = System.currentTimeMillis()
            phase[draft] = Dictation.Recording
        } catch (e: Exception) {
            listeners.remove(draft)?.cancel()
            phase.remove(draft)
            notes[draft] = sentence(e.message ?: "The microphone would not start")
        }
    }

    /**
     * Ends the recording and reads it. The draft is captured here, so words land in the draft
     * they were spoken into even if the reader has moved on.
     */
    fun stop(store: Store, draft: SessionKey) {
        val engine = engines[draft] ?: return
        if (state(draft) != Dictation.Recording) return
        since.remove(draft)
        if (sounds) sound.play(MediaActionSound.STOP_VIDEO_RECORDING)
        val run = UUID.randomUUID().toString()
        pending[draft] = run
        phase[draft] = Dictation.Transcribing
        store.scope.launch {
            val listener = listeners[draft]
            if (listener != null) {
                val outcome = listener.stop()
                listeners.remove(draft)
                if (pending[draft] == run) land(store, engine, draft, outcome)
                finish(draft, run)
                return@launch
            }
            val r = recorders.remove(draft) ?: return@launch finish(draft, run)
            withContext(Dispatchers.IO) { r.stop() }
            send(store, engine, draft, r.file, run)
        }
    }

    /** Two controls, as on the desktop: Cancel throws the words away, Stop keeps them. */
    fun cancel(draft: SessionKey) {
        listeners.remove(draft)?.cancel()
        recorders.remove(draft)?.let { r -> Thread { r.discard() }.start() }
        since.remove(draft)
        if (pending.remove(draft) != null) notes.remove(draft)
        phase.remove(draft)
    }

    fun retry(store: Store, draft: SessionKey) {
        val file = kept.remove(draft) ?: return
        val engine = engines[draft] ?: return
        notes.remove(draft)
        val run = UUID.randomUUID().toString()
        pending[draft] = run
        phase[draft] = Dictation.Transcribing
        store.scope.launch { send(store, engine, draft, file, run) }
    }

    /** Closing the note without retrying is the reader letting the recording go. */
    fun dismiss(draft: SessionKey) {
        notes.remove(draft)
        kept.remove(draft)?.delete()
    }

    /**
     * The file goes once the server has answered, whatever it said; a send that never reached it
     * keeps the file for Retry. A socket that dropped under it (the phone slept, the network moved)
     * gets one more try once it is back.
     */
    private suspend fun send(store: Store, engine: DictationEngine, draft: SessionKey, file: File, run: String, again: Boolean = true) {
        val server = (engine as? DictationEngine.Server)?.id ?: return finish(draft, run)
        try {
            val outcome = store.transcribe(server, file)
            file.delete()
            if (pending[draft] == run) land(store, engine, draft, outcome)
            finish(draft, run)
        } catch (e: Exception) {
            if (pending[draft] != run) {
                file.delete()
                return finish(draft, run)
            }
            if (again && store.serverState[server] != ConnState.Connected) {
                for (i in 0 until 40) {
                    if (store.canDictate(server) || pending[draft] != run) break
                    delay(500)
                }
                if (pending[draft] == run && store.canDictate(server)) return send(store, engine, draft, file, run, again = false)
            }
            if (pending[draft] != run) {
                file.delete()
                return finish(draft, run)
            }
            kept[draft] = file
            notes[draft] = "Couldn't transcribe: ${e.message}"
            finish(draft, run)
        }
    }

    private fun land(store: Store, engine: DictationEngine, draft: SessionKey, outcome: TranscribeOutcome) {
        when (outcome) {
            is TranscribeOutcome.Text -> if (outcome.words.isNotBlank()) store.appendToDraft(draft, outcome.words.trim())
                else notes[draft] = "No words heard."
            TranscribeOutcome.NeedsModel -> notes[draft] =
                "${store.name(engine)} has no transcription model. Download one in Dray's settings, under Transcription."
            TranscribeOutcome.NoAudio -> notes[draft] = "No sound reached the microphone."
            TranscribeOutcome.Empty -> notes[draft] = "No words heard."
            is TranscribeOutcome.Failed -> notes[draft] = sentence(outcome.message)
        }
    }

    private fun finish(draft: SessionKey, run: String) {
        if (pending[draft] == run) {
            pending.remove(draft)
            phase.remove(draft)
        }
    }
}
