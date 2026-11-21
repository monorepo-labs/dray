package com.yogesh.dray.ui

import android.graphics.RuntimeShader
import android.os.Build
import androidx.annotation.RequiresApi
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ShaderBrush
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.yogesh.dray.model.SessionKey
import com.yogesh.dray.voice.Dictation
import com.yogesh.dray.voice.Dictations
import kotlin.math.PI
import kotlin.math.ceil
import kotlin.math.exp
import kotlin.math.min

/** The voice orb both docks draw: tapped to talk, tapped again to stop. VoiceDock.swift's `DockOrb`. */
@Composable
fun DockOrb(draft: SessionKey, size: Dp, tap: () -> Unit, modifier: Modifier = Modifier) {
    val state = Dictations.state(draft)
    Box(
        modifier
            .size(size)
            .shadow(if (size > 76.dp) 20.dp else 14.dp, CircleShape, ambientColor = Color.Black, spotColor = Color.Black)
            .clip(CircleShape)
            .border(1.dp, Color.White.copy(alpha = 0.08f), CircleShape)
            .clickable(remember { MutableInteractionSource() }, indication = null, role = Role.Button, onClick = tap)
            .semantics {
                contentDescription = "Voice"
                stateDescription = if (state == Dictation.Recording) "Recording" else ""
            },
    ) {
        VoiceOrb(size, state) { if (state == Dictation.Recording) Dictations.level(draft) else 0f }
    }
}

/**
 * The dictation orb: clear dark glass with sunlight caught inside it, split into a rainbow band
 * with a white filament through it. A wave flows along the band, swelling with the voice;
 * transcribing curls the band into an arc that orbits the rim, and stopping brings the arc home
 * before it uncurls. The Island's VoiceOrb.swift and its `prism` shader, as AGSL; a phone before
 * Android 13 has no runtime shaders and runs the same math on the CPU.
 */
@Composable
fun VoiceOrb(size: Dp, state: Dictation, cpu: Boolean = false, level: () -> Float) {
    var frame by remember { mutableStateOf(OrbFrame()) }
    val voice by rememberUpdatedState(level)
    val current by rememberUpdatedState(state)
    LaunchedEffect(state) {
        var last = 0L
        var idleFor = 0.0
        while (true) {
            withFrameNanos { now ->
                val dt = if (last == 0L) 0.0 else min((now - last) / 1e9, 0.1)
                last = now
                frame = frame.next(dt, current, voice())
                idleFor = if (current == Dictation.Idle) idleFor + dt else 0.0
            }
            // Idle long enough that the orbit has wound home and uncurled: the orb holds still.
            if (idleFor > 3) break
        }
    }
    val sizePx = size
    Box(
        Modifier.size(size).drawWithCache {
            if (Build.VERSION.SDK_INT >= 33 && !cpu) {
                val shader = RuntimeShader(PRISM)
                val brush = ShaderBrush(shader)
                onDrawBehind { drawPrism(shader, brush, frame, sizePx.value) }
            } else {
                val cpu = CpuPrism()
                onDrawBehind { cpu.draw(this, frame, sizePx.value) }
            }
        },
    )
}

/** One frame of an orb, every input already eased, so whatever draws it holds no state of its own. */
data class OrbFrame(
    val t: Double = 0.0,
    val spin: Double = 0.0,
    val curl: Double = 0.0,
    /** The voice, eased over ~0.15s. */
    val level: Double = 0.0,
    /** The voice eased over ~1s: how much has been said lately. */
    val energy: Double = 0.0,
    /** 0…1 into recording, from the press. */
    val rec: Double = 0.0,
    /** 0…1 into transcribing. */
    val work: Double = 0.0,
) {
    /**
     * Eases every input toward the state and advances the clock: a phase running at a variable rate,
     * so speeding up never jumps, and the transcribing orbit, which finishes its lap before it uncurls.
     */
    fun next(dt: Double, state: Dictation, raw: Float): OrbFrame {
        fun ease(from: Double, to: Double, tau: Double) = from + (to - from) * (1 - exp(-dt / tau))
        val voice = if (state == Dictation.Recording) raw.toDouble() else 0.0
        val recNow = ease(rec, if (state == Dictation.Starting || state == Dictation.Recording) 1.0 else 0.0, 0.15)
        val workNow = ease(work, if (state == Dictation.Transcribing) 1.0 else 0.0, 0.15)
        val energyNow = ease(energy, voice, 0.35)
        val working = state == Dictation.Transcribing
        val rate = 0.35 + 0.8 * recNow + 0.6 * workNow + 0.3 * energyNow
        val winding = !working && spin > 0
        val curlNow = curl + ((if (working || winding) 1.0 else 0.0) - curl) * (1 - exp(-dt / 0.15))
        var spinNow = spin
        if (working) spinNow += dt * 2.6 * curlNow
        else if (winding) {
            val home = ceil(spin / (2 * PI)) * 2 * PI
            spinNow = min(home, spin + dt * maxOf(4.0, 8 * (home - spin)))
            if (spinNow >= home - 0.002) spinNow = 0.0
        }
        return OrbFrame(
            t = (t + dt * rate) % 3600, spin = spinNow % (2 * PI), curl = curlNow,
            level = ease(level, voice, 0.05), energy = energyNow, rec = recNow, work = workNow,
        )
    }
}

@RequiresApi(33)
private fun DrawScope.drawPrism(shader: RuntimeShader, brush: ShaderBrush, f: OrbFrame, dp: Float) {
    shader.setFloatUniform("size", this.size.width, this.size.height)
    shader.setFloatUniform("dp", dp)
    shader.setFloatUniform("t", f.t.toFloat())
    shader.setFloatUniform("level", f.level.toFloat())
    shader.setFloatUniform("energy", f.energy.toFloat())
    shader.setFloatUniform("rec", f.rec.toFloat())
    shader.setFloatUniform("spin", f.spin.toFloat())
    shader.setFloatUniform("curl", f.curl.toFloat())
    drawRect(brush)
}

/**
 * Before Android 13 there are no runtime shaders, so the same `prism` math runs here on the CPU,
 * a pixel at a time into a small bitmap drawn up to size: the same orb, softer at the edge.
 */
private class CpuPrism {
    private var bitmap: android.graphics.Bitmap? = null
    private var pixels = IntArray(0)

    fun draw(scope: DrawScope, f: OrbFrame, dp: Float) {
        val n = 72
        val b = bitmap ?: android.graphics.Bitmap.createBitmap(n, n, android.graphics.Bitmap.Config.ARGB_8888).also {
            bitmap = it
            pixels = IntArray(n * n)
        }
        val u = Prism(n.toFloat(), dp, f)
        for (y in 0 until n) for (x in 0 until n) pixels[y * n + x] = u.pixel(x + 0.5f, y + 0.5f)
        b.setPixels(pixels, 0, n, 0, 0, n, n)
        scope.drawContext.canvas.nativeCanvas.drawBitmap(b, null,
            android.graphics.RectF(0f, 0f, scope.size.width, scope.size.height), android.graphics.Paint(android.graphics.Paint.FILTER_BITMAP_FLAG))
    }
}

/** `PRISM` below, line for line in Kotlin. Change one, change the other. */
private class Prism(val side: Float, val dp: Float, val f: OrbFrame) {
    private val t = f.t.toFloat()
    private val level = f.level.toFloat()
    private val energy = f.energy.toFloat()
    private val rec = f.rec.toFloat()
    private val spin = f.spin.toFloat()
    private val bend = smooth(0f, 1f, f.curl.toFloat())

    private fun sat(x: Float) = x.coerceIn(0f, 1f)
    private fun smooth(a: Float, b: Float, x: Float): Float { val k = sat((x - a) / (b - a)); return k * k * (3 - 2 * k) }
    private fun mix(a: Float, b: Float, k: Float) = a + (b - a) * k
    private fun fract(x: Float) = x - kotlin.math.floor(x)
    private fun hash(px: Float, py: Float): Float {
        var x = fract(px * 123.34f)
        var y = fract(py * 456.21f)
        val d = x * (x + 45.32f) + y * (y + 45.32f)
        x += d
        y += d
        return fract(x * y)
    }
    private fun noise(px: Float, py: Float): Float {
        val ix = kotlin.math.floor(px)
        val iy = kotlin.math.floor(py)
        val fx = px - ix
        val fy = py - iy
        val ux = fx * fx * (3 - 2 * fx)
        val uy = fy * fy * (3 - 2 * fy)
        return mix(mix(hash(ix, iy), hash(ix + 1, iy), ux), mix(hash(ix, iy + 1), hash(ix + 1, iy + 1), ux), uy)
    }
    private fun bump(x: Float, c: Float, w: Float): Float { val d = (x - c) / w; return sat(1 - d * d) }
    private fun spectral(x: Float, out: FloatArray) {
        out[0] = (bump(x, 0.15f, 0.32f) + 0.35f * bump(x, 0.95f, 0.12f)) * 0.85f + 0.12f
        out[1] = bump(x, 0.42f, 0.22f) * 0.85f + 0.12f
        out[2] = bump(x, 0.78f, 0.25f) * 0.85f + 0.12f
    }
    private val c = FloatArray(3)

    fun pixel(px: Float, py: Float): Int {
        val ux = (px - side / 2) / (side / 2)
        val uy = (py - side / 2) / (side / 2)
        val r = kotlin.math.sqrt(ux * ux + uy * uy)
        val aa = 2f / side
        val big = 0.95f
        val mask = 1 - smooth(big - aa * 2, big, r)
        if (mask <= 0f) return 0
        val dx = if (r > 1e-4f) ux / r else 1f
        val dy = if (r > 1e-4f) uy / r else 0f

        val small = 1 - smooth(30f, 46f, dp)
        val base = (0.03f + 0.07f * small * (1 - 0.4f * (uy + 1))) * (1 + 0.2f * rec)
        var br = base
        var bg = base
        var bb = base
        val rim = smooth(0.7f - 0.12f * small, big, r)
        val lit = rim * (0.06f + 0.28f * small) * mix(0.5f + sat(dx * 0.6508f + dy * 0.7593f), 1f, small)
        br += lit; bg += lit; bb += lit
        spectral(sat((r - 0.8f) / 0.14f), c)
        val edge = rim * sat(-dx * 1.2f) * 0.45f * (1 - small)
        br += c[0] * edge; bg += c[1] * edge; bb += c[2] * edge
        val gx = ux + 0.42f
        val gy = uy + 0.48f
        val glint = kotlin.math.exp(-(gx * gx + gy * gy) / 0.018f) * 0.7f * small
        br += glint; bg += glint; bb += glint

        val cs = kotlin.math.cos(-spin)
        val sn = kotlin.math.sin(-spin)
        val qx = cs * ux - sn * uy
        val qy = sn * ux + cs * uy
        val ring = 0.78f
        val mid = mix(0.06f, ring, bend)
        var x = qx
        var d = qy - mid
        if (bend > 1e-3f) {
            val rho = ring / bend
            val vx = qx
            val vy = qy - (mid - rho)
            x = rho * kotlin.math.atan2(vx, vy)
            d = kotlin.math.sqrt(vx * vx + vy * vy) - rho
        }
        val wave = ((0.06f + 0.1f * energy + 0.03f * level) * kotlin.math.sin(x * 2.4f - t * 2.1f)
            + (0.015f + 0.05f * energy) * kotlin.math.sin(x * 4.1f - t * 3.0f + 1.0f)) * (1 - 0.75f * bend)
        d -= wave
        val width = (0.17f + 0.05f * energy + 0.02f * level) * (1 - 0.35f * bend) * (1 + 0.35f * small)
        val s = d / width
        val q = (x + 0.08f) / (0.42f + 0.12f * energy)
        val along = kotlin.math.exp(-q * q)
        val shimmer = 0.8f + 0.4f * noise(x * 4f + t * 0.6f, t * 0.3f)
        val comet = mix(1f, 0.35f + 1.1f * smooth(0.7f, -0.5f, x), bend)
        val power = (0.6f + 0.25f * rec + 0.4f * energy + 0.25f * level + 0.3f * bend) * shimmer * comet * (1 + 0.15f * small)

        spectral(sat(0.45f + s * 0.42f), c)
        for (i in 0..2) c[i] = mix(c[i], sat(c[i] * 1.35f - 0.18f), small)
        val core = kotlin.math.exp(-s * s * 1.3f) * along * 1.3f
        var lr = c[0] * core
        var lg = c[1] * core
        var lb = c[2] * core
        val wx = x + 0.06f
        val wy = d + 0.15f
        val warm = kotlin.math.exp(-(wx * wx + wy * wy) / 0.08f) * (1 - 0.8f * bend) * (1 - 0.5f * small)
        lr += warm; lg += 0.7f * warm; lb += 0.3f * warm
        val fw = maxOf(0.022f, aa * 0.9f)
        val fy = d - 0.05f - 0.04f * kotlin.math.sin(x * 3.2f + 0.8f - t * 2.1f) * (1 - 0.75f * bend)
        val reach = smooth(-0.6f, -0.25f, x) * smooth(0.75f, 0.35f, x)
        val fil = kotlin.math.exp(-fy * fy / (fw * fw)) * reach * 1.4f * (1 - 0.45f * small)
        lr += fil; lg += 0.98f * fil; lb += 0.95f * fil
        val bd = (d - 0.2f) / 0.12f
        val blue = kotlin.math.exp(-bd * bd) * along * 0.35f
        lr += 0.35f * blue; lg += 0.4f * blue; lb += blue

        // A colour int is unpremultiplied; the bitmap premultiplies it, where Metal returns it premultiplied.
        fun ch(v: Float) = (sat(v) * 255f + 0.5f).toInt()
        return ((mask * 255f + 0.5f).toInt() shl 24) or (ch(br + lr * power) shl 16) or (ch(bg + lg * power) shl 8) or ch(bb + lb * power)
    }
}

/**
 * VoiceOrb.metal's `prism` with its shipped inputs, clear glass and the true rainbow, which leaves
 * the palette unread. Positions here are pixels where Metal's are points, so `dp` carries the size
 * the small-orb lift is judged on.
 */
private const val PRISM = """
uniform float2 size;
uniform float dp;
uniform float t;
uniform float level;
uniform float energy;
uniform float rec;
uniform float spin;
uniform float curl;

float sat(float x) { return clamp(x, 0.0, 1.0); }
float3 sat3(float3 x) { return clamp(x, 0.0, 1.0); }

float hash21(float2 p) {
    p = fract(p * float2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}

float noise(float2 p) {
    float2 i = floor(p);
    float2 f = fract(p);
    float2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash21(i), hash21(i + float2(1, 0)), u.x), mix(hash21(i + float2(0, 1)), hash21(i + float2(1, 1)), u.x), u.y);
}

float2 rot(float2 p, float a) {
    float c = cos(a);
    float s = sin(a);
    return float2(c * p.x - s * p.y, s * p.x + c * p.y);
}

float bump(float x, float c, float w) { float d = (x - c) / w; return sat(1.0 - d * d); }

float3 spectral(float x) {
    float3 c = float3(bump(x, 0.15, 0.32) + 0.35 * bump(x, 0.95, 0.12), bump(x, 0.42, 0.22), bump(x, 0.78, 0.25));
    return c * 0.85 + 0.12;
}

half4 main(float2 pos) {
    float2 uv = (pos - size * 0.5) / (size.x * 0.5);
    float r = length(uv);
    float aa = 2.0 / size.x;
    float R = 0.95;
    float mask = 1.0 - smoothstep(R - aa * 2.0, R, r);
    if (mask <= 0.0) return half4(0);
    float2 dir = r > 1e-4 ? uv / r : float2(1, 0);

    float small = 1.0 - smoothstep(30.0, 46.0, dp);
    float3 body = float3(0.03 + 0.07 * small * (1.0 - 0.4 * (uv.y + 1.0))) * (1.0 + 0.2 * rec);
    float rim = smoothstep(0.7 - 0.12 * small, R, r);
    body += rim * (0.06 + 0.28 * small) * mix(0.5 + sat(dot(dir, normalize(float2(0.6, 0.7)))), 1.0, small);
    body += spectral(sat((r - 0.8) / 0.14)) * rim * sat(-dir.x * 1.2) * 0.45 * (1.0 - small);
    float2 glint = uv - float2(-0.42, -0.48);
    body += exp(-dot(glint, glint) / 0.018) * 0.7 * small;

    float bend = smoothstep(0.0, 1.0, curl);
    float ring = 0.78;
    float2 p = rot(uv, -spin);
    float mid = mix(0.06, ring, bend);
    float x = p.x;
    float d = p.y - mid;
    if (bend > 1e-3) {
        float rho = ring / bend;
        float2 v = p - float2(0.0, mid - rho);
        x = rho * atan(v.x, v.y);
        d = length(v) - rho;
    }
    float wave = ((0.06 + 0.1 * energy + 0.03 * level) * sin(x * 2.4 - t * 2.1)
               + (0.015 + 0.05 * energy) * sin(x * 4.1 - t * 3.0 + 1.0)) * (1.0 - 0.75 * bend);
    d -= wave;
    float width = (0.17 + 0.05 * energy + 0.02 * level) * (1.0 - 0.35 * bend) * (1.0 + 0.35 * small);
    float s = d / width;
    float q = (x + 0.08) / (0.42 + 0.12 * energy);
    float along = exp(-q * q);
    float shimmer = 0.8 + 0.4 * noise(float2(x * 4.0 + t * 0.6, t * 0.3));
    float comet = mix(1.0, 0.35 + 1.1 * smoothstep(0.7, -0.5, x), bend);
    float power = (0.6 + 0.25 * rec + 0.4 * energy + 0.25 * level + 0.3 * bend) * shimmer * comet * (1.0 + 0.15 * small);

    float3 hues = spectral(sat(0.45 + s * 0.42));
    hues = mix(hues, sat3(hues * 1.35 - 0.18), small);
    float3 light = hues * exp(-s * s * 1.3) * along * 1.3;
    float2 warm = float2(x + 0.06, d + 0.15);
    light += float3(1.0, 0.7, 0.3) * exp(-dot(warm, warm) / 0.08) * (1.0 - 0.8 * bend) * (1.0 - 0.5 * small);
    float fw = max(0.022, aa * 0.9);
    float fy = d - 0.05 - 0.04 * sin(x * 3.2 + 0.8 - t * 2.1) * (1.0 - 0.75 * bend);
    float reach = smoothstep(-0.6, -0.25, x) * smoothstep(0.75, 0.35, x);
    light += float3(1.0, 0.98, 0.95) * exp(-fy * fy / (fw * fw)) * reach * 1.4 * (1.0 - 0.45 * small);
    float b = (d - 0.2) / 0.12;
    light += float3(0.35, 0.4, 1.0) * exp(-b * b) * along * 0.35;

    float3 col = sat3(body + light * power);
    return half4(half3(col * mask), half(mask));
}
"""
