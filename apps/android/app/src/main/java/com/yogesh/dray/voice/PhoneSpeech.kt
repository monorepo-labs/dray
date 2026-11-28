package com.yogesh.dray.voice

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Android's own speech recognizer: AppleSpeech.swift's place, the engine that needs no server.
 * The on-device recognizer where the phone has one (Android 12 and up, a language pack down),
 * so the voice never leaves the phone; otherwise the phone's speech service, which may send it
 * to its maker. Unlike Apple's model it listens live rather than reading a file, so a run here
 * is the recording and the transcription both.
 */
object PhoneSpeech {
    /** Settings' pick for this engine, stored where a server's id would be. */
    const val PICK = "phone"

    fun onDevice(context: Context): Boolean =
        Build.VERSION.SDK_INT >= 31 && SpeechRecognizer.isOnDeviceRecognitionAvailable(context)

    fun usable(context: Context): Boolean = onDevice(context) || SpeechRecognizer.isRecognitionAvailable(context)

    /** The speech service's own name, for "Through Speech Services by Google". */
    fun serviceName(context: Context): String? {
        val flat = Settings.Secure.getString(context.contentResolver, "voice_recognition_service") ?: return null
        val pm = context.packageManager
        val pkg = ComponentName.unflattenFromString(flat)?.packageName ?: return null
        return runCatching { pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString() }.getOrNull()
    }

    /**
     * One dictation: listens until stopped, starting again each time the recognizer decides a
     * pause ended the speech, so a long dictation with breaths in it is one recording. Every call
     * is on the main thread, as `SpeechRecognizer` asks.
     */
    class Run(context: Context) {
        private val recognizer = if (onDevice(context)) SpeechRecognizer.createOnDeviceSpeechRecognizer(context)
            else SpeechRecognizer.createSpeechRecognizer(context)
        private val said = mutableListOf<String>()
        private var partial = ""
        private var stopping = false
        private var heardAudio = false
        private val done = CompletableDeferred<TranscribeOutcome>()

        /** The voice, 0…1, as the orb reads it. */
        @Volatile var level = 0f
            private set

        private val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            .putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.packageName)
            // Honoured by some services: a thinking pause doesn't end the speech.
            .putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 4000L)

        init {
            recognizer.setRecognitionListener(object : RecognitionListener {
                override fun onReadyForSpeech(params: Bundle?) {}
                override fun onBeginningOfSpeech() { heardAudio = true }
                // The service's RMS runs about -2 to 10 dB.
                override fun onRmsChanged(rmsdB: Float) { level = ((rmsdB + 2f) / 12f).coerceIn(0f, 1f) }
                override fun onBufferReceived(buffer: ByteArray?) {}
                override fun onEndOfSpeech() { level = 0f }
                override fun onPartialResults(results: Bundle?) { partial = best(results) ?: partial }
                override fun onEvent(eventType: Int, params: Bundle?) {}

                override fun onResults(results: Bundle?) {
                    best(results)?.takeIf { it.isNotBlank() }?.let { said += it }
                    partial = ""
                    if (stopping) finish() else listen()
                }

                override fun onError(error: Int) {
                    val quiet = error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT
                    when {
                        stopping -> finish()
                        quiet -> listen()
                        else -> fail(error)
                    }
                }
            })
        }

        private fun best(results: Bundle?) = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()

        fun start() = listen()

        private fun listen() {
            if (!done.isCompleted) recognizer.startListening(intent)
        }

        /** Done: whatever the recognizer still holds comes back, or what it had heard by now. */
        suspend fun stop(): TranscribeOutcome {
            stopping = true
            recognizer.stopListening()
            return withTimeoutOrNull(5_000) { done.await() } ?: run { finish(); done.await() }
        }

        fun cancel() {
            done.complete(TranscribeOutcome.Empty)
            recognizer.cancel()
            recognizer.destroy()
        }

        private fun finish() {
            if (done.isCompleted) return
            if (partial.isNotBlank()) said += partial
            val text = said.joinToString(" ").trim()
            done.complete(when {
                text.isNotEmpty() -> TranscribeOutcome.Text(text)
                heardAudio -> TranscribeOutcome.Empty
                else -> TranscribeOutcome.NoAudio
            })
            recognizer.destroy()
        }

        private fun fail(error: Int) {
            if (done.isCompleted) return
            if (said.isNotEmpty() || partial.isNotBlank()) return finish()
            done.complete(TranscribeOutcome.Failed(when (error) {
                SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Dray can't use the microphone"
                SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "The speech service needs the network"
                SpeechRecognizer.ERROR_AUDIO -> "The microphone would not start"
                SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "The speech service is busy"
                SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED, SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE ->
                    "The speech service doesn't support this language yet"
                else -> "The speech service stopped (error $error)"
            }))
            recognizer.destroy()
        }

        /** Returns once the run is over, including a recognizer giving up on its own mid-recording. */
        suspend fun awaitEnd() { done.await() }
    }
}
