package com.yogesh.dray.voice

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.abs
import kotlin.math.max

/**
 * The microphone into a WAV a server's model reads: 16 kHz mono 16-bit PCM, what
 * `recordings::read` accepts and Dictation.swift records. The header is written last,
 * once the length is known.
 */
class WavRecorder(val file: File) {
    private val rate = 16_000
    private val size = max(AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT), rate / 5)
    @SuppressLint("MissingPermission") // The dock asks before any start.
    private val record = AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, size)
    private var thread: Thread? = null
    @Volatile private var running = false
    @Volatile private var peak = 0f
    private var bytes = 0L

    /** The loudest sample since last asked, linear 0…1, as Dictation.swift's meter reads it. */
    fun takePeak(): Float = peak.also { peak = 0f }

    fun start(): Boolean {
        if (record.state != AudioRecord.STATE_INITIALIZED) return false
        record.startRecording()
        if (record.recordingState != AudioRecord.RECORDSTATE_RECORDING) return false
        running = true
        thread = Thread({
            FileOutputStream(file).use { out ->
                out.write(ByteArray(44))
                val buf = ShortArray(size / 2)
                val raw = ByteBuffer.allocate(buf.size * 2).order(ByteOrder.LITTLE_ENDIAN)
                while (running) {
                    val n = record.read(buf, 0, buf.size)
                    if (n <= 0) continue
                    var loud = 0
                    raw.clear()
                    for (i in 0 until n) {
                        loud = max(loud, abs(buf[i].toInt()))
                        raw.putShort(buf[i])
                    }
                    peak = max(peak, loud / 32768f)
                    out.write(raw.array(), 0, n * 2)
                    bytes += n * 2
                }
            }
        }, "dictation").apply { start() }
        return true
    }

    /** Stops and finishes the file; it is whole once this returns. */
    fun stop() {
        running = false
        runCatching { record.stop() }
        thread?.join(2000)
        record.release()
        writeHeader()
    }

    fun discard() {
        stop()
        file.delete()
    }

    private fun writeHeader() {
        val h = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
        h.put("RIFF".toByteArray()).putInt((36 + bytes).toInt()).put("WAVE".toByteArray())
        h.put("fmt ".toByteArray()).putInt(16).putShort(1).putShort(1).putInt(rate).putInt(rate * 2).putShort(2).putShort(16)
        h.put("data".toByteArray()).putInt(bytes.toInt())
        runCatching { RandomAccessFile(file, "rw").use { it.seek(0); it.write(h.array()) } }
    }
}
