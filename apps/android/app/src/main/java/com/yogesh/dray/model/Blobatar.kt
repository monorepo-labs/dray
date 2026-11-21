package com.yogesh.dray.model

import com.yogesh.dray.wire.BotAvatar
import java.text.Normalizer
import java.util.Locale
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * A bot's face: Blobatar 2.7 and the desktop's `botAvatar.ts`, restated from the island's bundled
 * `botface.js` (what iOS runs in JavaScriptCore), since Android ships no JS engine. Same numbers,
 * same path strings, so a face matches the desktop's; `BlobatarTest` holds it to the JS output.
 * Rebuild both after a blobatar bump.
 */
object Blobatar {
    /** One filled part in Blobatar's 0–100 box: a circle, or SVG path data in absolute M, L, H, V, C, Q and Z. */
    sealed interface Part {
        val fill: String
        data class Circle(override val fill: String, val cx: Double, val cy: Double, val r: Double) : Part
        data class Shape(override val fill: String, val d: String) : Part
    }

    /** `SHAPES` in botAvatar.ts: each pinned by a position in its band, the droplet left out on purpose. */
    val shapes = listOf(
        "round" to 0.11, "organic" to 0.35, "boxy" to 0.54, "capsule" to 0.65, "nub" to 0.745,
        "cloud" to 0.825, "hexagon" to 0.9325, "sun" to 0.965, "triangle" to 0.99,
    )
    /** `HUES`, in its order. */
    val hues = listOf("Red" to 25.0, "Orange" to 50.0, "Amber" to 80.0, "Green" to 145.0, "Teal" to 185.0, "Blue" to 250.0, "Purple" to 295.0, "Pink" to 340.0)
    val defaultAvatar = BotAvatar("cloud", 250.0)
    /** The swatch every picked face takes, pale (0) to ink (1). */
    private const val TONE = 0.55

    /** `botFace(seed, avatar)`: the face's parts, head first, eyes over it. */
    fun face(seed: String, avatar: BotAvatar?): List<Part> {
        val pick = avatar ?: seededAvatar(seed)
        val position = shapes.firstOrNull { it.first == pick.shape }?.second ?: shapes[0].second
        val t = Traits(seed, position)
        val palette = palette(pick.hue, TONE)
        val l = layout(t)
        val head = palette.getValue("head")
        val eye = palette.getValue("eye")
        return l.petals.map { Part.Circle(head, round2(it[0]), round2(it[1]), round2(it[2])) } +
            l.extra.map { Part.Shape(head, it) } +
            Part.Shape(head, l.draw(l.body)) +
            l.eyes.map { Part.Shape(eye, superellipse(it)) }
    }

    /** A face for something with no pick of its own: `seededAvatar`, shape and colour from the seed. */
    fun seededAvatar(seed: String): BotAvatar {
        var hash = 0
        var i = 0
        while (i < seed.length) {
            // `for…of` walks code points and `charCodeAt(0)` reads each one's first unit.
            hash = hash * 31 + seed[i].code
            i += Character.charCount(seed.codePointAt(i))
        }
        hash = (hash xor (hash ushr 16)) * 73244475
        hash = hash xor (hash ushr 16)
        val u = hash.toLong() and 0xffffffffL
        return BotAvatar(shapes[(u % shapes.size).toInt()].first, hues[((u ushr 8) % hues.size).toInt()].second)
    }

    /** `swatch()`: `oklch(0.68 0.16 hue)` as sRGB, a picked face's own colour for the sheet's dots. */
    fun swatch(hue: Double): Long {
        val rgb = oklab(Lch(0.68, 0.16, hue)).map { it.coerceIn(0.0, 1.0) }
        return rgb.fold(0xFFL) { acc, c -> (acc shl 8) or Math.round(gamma(c) * 255) }
    }

    // Colour: OKLCH, gamut clipping and WCAG contrast, as Blobatar's palette does it.

    private data class Lch(var l: Double, var c: Double, val h: Double)

    private fun oklab(t: Lch): DoubleArray {
        val a = t.h * PI / 180
        val o = t.c * cos(a)
        val n = t.c * sin(a)
        val l = t.l + 0.3963377774 * o + 0.2158037573 * n
        val c = t.l - 0.1055613458 * o - 0.0638541728 * n
        val i = t.l - 0.0894841775 * o - 1.291485548 * n
        val s = l * l * l
        val h = c * c * c
        val u = i * i * i
        return doubleArrayOf(
            4.0767416621 * s - 3.3077115913 * h + 0.2309699292 * u,
            -1.2684380046 * s + 2.6097574011 * h - 0.3413193965 * u,
            -0.0041960863 * s - 0.7034186147 * h + 1.707614701 * u,
        )
    }

    private fun inGamut(rgb: DoubleArray) = rgb.all { it >= -1e-4 && it <= 1.0001 }

    private fun clipped(t: Lch): DoubleArray {
        var e = oklab(t)
        if (!inGamut(e)) {
            var lo = 0.0
            var hi = t.c
            repeat(12) {
                val mid = (lo + hi) / 2
                if (inGamut(oklab(t.copy(c = mid)))) lo = mid else hi = mid
            }
            e = oklab(t.copy(c = lo))
        }
        return DoubleArray(3) { min(1.0, max(0.0, e[it])) }
    }

    private fun luminance(t: Lch): Double {
        val (r, g, b) = clipped(t).let { Triple(it[0], it[1], it[2]) }
        return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }

    private fun contrast(a: Lch, b: Lch): Double {
        val x = luminance(a)
        val y = luminance(b)
        return (max(x, y) + 0.05) / (min(x, y) + 0.05)
    }

    /** Moves `t`'s lightness until it stands `ratio` off `against`, else black or white, whichever stands further. */
    private fun ensure(t: Lch, against: Lch, ratio: Double): Lch {
        if (contrast(t, against) >= ratio) return t
        val dir = if (t.l >= against.l) 1 else -1
        for (step in listOf(dir, -dir)) {
            val c = t.copy()
            for (i in 0 until 60) {
                c.l = min(1.0, max(0.0, c.l + step * 0.02))
                if (contrast(c, against) >= ratio) return c
                if (c.l == 0.0 || c.l == 1.0) break
            }
        }
        val black = t.copy(l = 0.0, c = 0.0)
        val white = t.copy(l = 1.0, c = 0.0)
        return if (contrast(black, against) >= contrast(white, against)) black else white
    }

    private fun gamma(e: Double) = if (e <= 0.0031308) 12.92 * e else 1.055 * e.pow(1 / 2.4) - 0.055

    private fun hex(t: Lch): String = "#" + clipped(t).joinToString("") { "%02x".format(Math.round(gamma(it) * 255)) }

    private val tones = listOf(0.2 to (0.86 to 0.085), 0.36 to (0.9 to 0.028), 0.62 to (0.73 to 0.135), 0.8 to (0.62 to 0.165), 0.93 to (0.87 to 0.16), 1.0 to (0.34 to 0.035))

    private fun palette(hue: Double, tone: Double): Map<String, String> {
        val (l, c) = tones.firstOrNull { tone < it.first }?.second ?: tones[0].second
        val ink = Lch(0.145, 0.0, 0.0)
        val bg = Lch(0.965, 0.01, hue)
        var head = ensure(Lch(l, c, hue), ink, 1.5)
        var eye = if (head.l >= 0.5) Lch(0.17, 0.02, hue) else Lch(0.97, 0.012, hue)
        head = ensure(head, bg, 1.25)
        eye = ensure(eye, head, 4.5)
        return mapOf("bg" to hex(bg), "head" to hex(head), "eye" to hex(eye))
    }

    // The seeded random: every trait is a hash of the seed and the trait's name, so order never matters.

    private fun mix(start: Int, bytes: ByteArray): Int {
        var t = start
        for (b in bytes) {
            t = (t xor (b.toInt() and 0xff)) * -862048943 // 3432918353
            t = (t shl 13) or (t ushr 19)
        }
        return t
    }

    private fun finish(start: Int): Long {
        var t = (start xor (start ushr 16)) * -2048144789 // 2246822507
        t = (t xor (t ushr 13)) * -1028477387 // 3266489909
        return (t xor (t ushr 16)).toLong() and 0xffffffffL
    }

    private class Traits(seed: String, private val shape: Double) {
        private val base: Int = run {
            val s = Normalizer.normalize(seed, Normalizer.Form.NFC).trim().lowercase(Locale.ROOT)
            mix(1779033703 xor s.length, s.toByteArray(Charsets.UTF_8))
        }

        operator fun invoke(name: String): Double {
            if (name == "shape") return if (shape > 0) min(shape, 0.999999) else 0.0
            return finish(mix(mix(base, byteArrayOf(-1)), name.toByteArray(Charsets.UTF_8))) / 4294967296.0
        }

        fun num(n: String, lo: Double, hi: Double) = lo + this(n) * (hi - lo)
        fun int(n: String, lo: Int, hi: Int) = lo + floor(this(n) * (hi - lo + 1)).toInt()
        fun jitter(n: String, by: Double) = (this(n) * 2 - 1) * by
    }

    // Layout

    private class Body(
        var cx: Double, var cy: Double, var rx: Double, var ry: Double,
        var n: Double = 4.0, var rot: Double = 0.0, var radii: List<Double> = emptyList(),
        var sides: Int = 0, var round: Double = 0.3,
    )

    private class Kind(
        val core: Double,
        val body: ((Traits, Body) -> Unit)? = null,
        val face: ((Body) -> Body)? = null,
        val decorate: ((Traits, Body, MutableList<DoubleArray>, MutableList<String>) -> Unit)? = null,
        val path: ((Body) -> String)? = null,
    )

    private fun scaled(k: Double) = { b: Body -> Body(b.cx, b.cy, b.rx * k, b.ry * k) }
    private val inner = { b: Body -> scaled(b.radii.min() * 0.95)(b) }
    private val blob = { b: Body -> catmull(b.cx, b.cy, b.rx, b.ry, b.radii, b.rot) }
    private val poly = { b: Body -> polygon(b) }

    private val kinds: List<Pair<Kind, Double>> = listOf(
        Kind(1.0) to 0.22,
        Kind(0.98, path = blob, face = inner) to 0.48,
        Kind(0.86, body = { t, e -> e.n = t.num("body.n", 3.4, 6.0); e.rot = t.num("body.rot", -20.0, 20.0) }) to 0.6,
        Kind(
            1.02,
            body = { t, e -> e.ry *= t.num("capsule.squat", 0.55, 0.68) },
            face = scaled(0.94),
            decorate = { _, e, petals, _ -> for (a in listOf(-1, 1)) petals += doubleArrayOf(e.cx + a * (e.rx - e.ry), e.cy, e.ry) },
            path = { b -> rect(b.cx, b.cy, b.rx - b.ry, b.ry) },
        ) to 0.7,
        Kind(0.88, decorate = { t, e, petals, _ ->
            for (o in 0 until t.int("nub.n", 1, 2)) {
                val a = t.num("nub.a$o", 0.0, 2 * PI)
                petals += doubleArrayOf(e.cx + cos(a) * e.rx * 0.88, e.cy + sin(a) * e.rx * 0.88, e.rx * t.num("nub.r$o", 0.24, 0.4))
            }
        }) to 0.79,
        Kind(0.78, face = inner, path = blob, decorate = { t, e, petals, _ ->
            val count = t.int("cloud.n", 4, 6)
            for (o in 0 until count) {
                val a = PI + PI * (o + 0.5) / count
                petals += doubleArrayOf(e.cx + cos(a) * e.rx * 0.8, e.cy + sin(a) * e.rx * 0.5, e.rx * t.num("cloud.r$o", 0.44, 0.62))
            }
        }) to 0.86,
        Kind(
            0.78,
            body = { _, e -> e.cy += 0.22 * e.ry; e.n = 2.0 },
            face = { b -> Body(b.cx, b.cy + b.ry * 0.05, b.rx * 0.88, b.ry * 0.88) },
            decorate = { t, e, _, extra -> extra += droplet(e.cx, e.cy, e.rx, e.ry, t.num("droplet.tip", 1.4, 1.65)) },
        ) to 0.915,
        Kind(1.05, path = poly, face = scaled(0.84), body = { t, e ->
            e.sides = 6; e.rot = t.num("body.rot", -12.0, 12.0); e.round = t.num("poly.round", 0.24, 0.5)
        }) to 0.95,
        Kind(0.7, decorate = { t, e, petals, _ ->
            val count = t.int("sun.n", 6, 9)
            val dist = e.rx * t.num("sun.dist", 1.0, 1.08)
            val r = e.rx * t.num("sun.r", 0.2, 0.26)
            val turn = t.num("sun.rot", 0.0, 2 * PI)
            for (c in 0 until count) {
                val a = turn + 2 * PI * c / count
                petals += doubleArrayOf(e.cx + cos(a) * dist, e.cy + sin(a) * dist, r)
            }
        }) to 0.98,
        Kind(1.15, path = poly, body = { t, e ->
            e.sides = 3; e.rot = t.num("body.rot", -5.0, 5.0); e.round = t.num("poly.round", 0.24, 0.5)
        }, face = { b -> Body(b.cx, b.cy + b.ry * 0.1, b.rx * 0.54, b.ry * 0.36) }) to 1.0,
    )

    private class Layout(val body: Body, val draw: (Body) -> String, val petals: List<DoubleArray>, val extra: List<String>, val eyes: List<Body>)

    private fun layout(t: Traits): Layout {
        val s = t("shape")
        val kind = (kinds.firstOrNull { s < it.second } ?: kinds.last()).first
        val r = t.num("body.r", 31.0, 38.0) * kind.core
        val body = Body(
            cx = 50 + t.jitter("body.x", 1.5), cy = 50 + t.jitter("body.y", 1.5), rx = r,
            ry = r * t.num("body.ratio", 0.92, 1.08), n = t.num("body.n", 1.9, 2.5), rot = 0.0,
            radii = List(t.int("body.pts", 6, 8)) { 1 + t.jitter("body.r$it", 0.16) },
        )
        kind.body?.invoke(t, body)
        val face = kind.face?.invoke(body) ?: body
        val petals = mutableListOf<DoubleArray>()
        val extra = mutableListOf<String>()
        kind.decorate?.invoke(t, body, petals, extra)
        return Layout(body, kind.path ?: ::superellipse, petals, extra, eyes(t, body, face))
    }

    private fun eyes(t: Traits, e: Body, r: Body): List<Body> {
        val a = e.rx
        val o = t.num("eye.rx", 0.075, 0.105) * a
        val n = t.num("eye.ratio", 1.9, 3.2)
        val l = t.num("eye.scale", 0.78, 1.24)
        val c = t.num("eye.stretch", 0.85, 1.18)
        val i = t.num("eye.gap", 0.1, 0.24) * a
        val s = o * max(1.0, l)
        val h = o * n * max(1.0, l * c)
        val u = s + a * 0.03 + i
        val f = t.jitter("gaze.x", 0.09) * r.rx
        val p = t.num("gaze.y", -0.2, 0.08) * r.ry
        val x = t.jitter("eye.dy", 0.04) * r.ry
        val d = hypot(s, h)
        val m = hypot((abs(f) + u + d) / r.rx, (abs(p) + abs(x) + d) / r.ry)
        val y = if (m > 0.9) 0.9 / m else 1.0
        val b = o * y
        val ry = b * n
        val gap = u * y
        val q = min(12.0, asin(max(0.0, min(1.0, i / h))) * 180 / PI)
        val lean = t.num("eye.lean", -1.0, 1.0) * q
        val lean2 = max(-12.0, min(12.0, lean + t.jitter("eye.lean2", 3.5)))
        val cx = r.cx + f * y
        val cy = r.cy + p * y
        val k = t.num("eye.n", 3.5, 6.0)
        return listOf(
            Body(cx - gap, cy, b, ry, n = k, rot = lean),
            Body(cx + gap, cy + x * y, b * l, ry * l * c, n = k, rot = lean2),
        )
    }

    // Paths, written exactly as Blobatar writes them.

    private fun round2(v: Double): Double = Math.round(v * 100) / 100.0

    /** `String(Math.round(v * 100) / 100)`, negative zero as "0". */
    fun num(v: Double): String {
        val r = round2(v)
        if (r == 0.0) return "0"
        return if (r == floor(r) && abs(r) < 1e15) r.toLong().toString() else r.toString()
    }

    private fun superellipse(b: Body): String {
        val k = min(1.0, (8 * 2.0.pow(-1 / b.n) - 4) / 3)
        val (c, i) = b.rx to b.ry
        val (s, h) = c * k to i * k
        val u = listOf(c to 0.0, c to h, s to i, 0.0 to i, -s to i, -c to h, -c to 0.0, -c to -h, -s to -i, 0.0 to -i, s to -i, c to -h, c to 0.0)
        val f = b.rot * PI / 180
        val p = cos(f)
        val x = sin(f)
        fun d(y: Int): String {
            val (bx, by) = u[y]
            return "${num(b.cx + bx * p - by * x)} ${num(b.cy + bx * x + by * p)}"
        }
        val out = StringBuilder("M${d(0)}")
        var y = 1
        while (y < 13) { out.append("C${d(y)} ${d(y + 1)} ${d(y + 2)}"); y += 3 }
        return out.append("Z").toString()
    }

    private fun catmull(cx: Double, cy: Double, rx: Double, ry: Double, radii: List<Double>, rot: Double): String {
        val l = radii.size
        val c = rot * PI / 180
        val pts = radii.mapIndexed { f, u ->
            val a = c + 2 * PI * f / l
            doubleArrayOf(cx + rx * u * cos(a), cy + ry * u * sin(a))
        }
        fun s(u: Int) = pts[((u % l) + l) % l]
        val out = StringBuilder("M${num(s(0)[0])} ${num(s(0)[1])}")
        for (u in 0 until l) {
            val (f, p) = s(u - 1).let { it[0] to it[1] }
            val (x, d) = s(u).let { it[0] to it[1] }
            val (m, y) = s(u + 1).let { it[0] to it[1] }
            val (b, z) = s(u + 2).let { it[0] to it[1] }
            out.append("C${num(x + (m - f) / 6)} ${num(d + (y - p) / 6)} ${num(m - (b - x) / 6)} ${num(y - (z - d) / 6)} ${num(m)} ${num(y)}")
        }
        return out.append("Z").toString()
    }

    private fun polygon(b: Body): String {
        val o = b.sides
        val c = if (b.round > 0) (if (b.round < 1) b.round / 2 else 0.5) else 0.0
        val i = b.rot * PI / 180 - PI / 2
        val s = List(o) { x ->
            val d = i + 2 * PI * x / o
            doubleArrayOf(b.cx + b.rx * cos(d), b.cy + b.ry * sin(d))
        }
        fun h(p: Int) = s[((p % o) + o) % o]
        fun u(p: Int, x: Int): String {
            val a = h(p)
            val z = h(x)
            return "${num(a[0] + (z[0] - a[0]) * c)} ${num(a[1] + (z[1] - a[1]) * c)}"
        }
        val out = StringBuilder("M${u(0, -1)}")
        for (p in 0 until o) {
            val v = h(p)
            out.append("Q${num(v[0])} ${num(v[1])} ${u(p, p + 1)}")
            if (c < 0.5) out.append("L${u(p + 1, p)}")
        }
        return out.append("Z").toString()
    }

    private fun rect(cx: Double, cy: Double, rx: Double, ry: Double): String {
        val o = num(cx - rx)
        val n = num(cx + rx)
        return "M$o ${num(cy - ry)}H${n}V${num(cy + ry)}H${o}Z"
    }

    private fun droplet(t: Double, e: Double, r: Double, a: Double, o: Double): String {
        val n = max(1.05, o)
        val l = r * sqrt(1 - 1 / (n * n))
        val c = e - a / n
        val i = e - n * a
        val s = l * 0.14
        val h = c + 0.86 * (i - c)
        return "M${num(t - l)} ${num(c)}L${num(t - s)} ${num(h)}Q${num(t)} ${num(i)} ${num(t + s)} ${num(h)}L${num(t + l)} ${num(c)}Z"
    }

    /** The face as Blobatar's SVG body writes it, for holding this port to the JS. */
    fun svg(parts: List<Part>): String {
        val eyes = parts.takeLast(2)
        val heads = parts.dropLast(2)
        val sb = StringBuilder("<g fill=\"${heads.first().fill}\">")
        for (p in heads) when (p) {
            is Part.Circle -> sb.append("<circle cx=\"${num(p.cx)}\" cy=\"${num(p.cy)}\" r=\"${num(p.r)}\"/>")
            is Part.Shape -> sb.append("<path d=\"${p.d}\"/>")
        }
        sb.append("</g><g fill=\"${eyes.first().fill}\">")
        for (p in eyes) sb.append("<path d=\"${(p as Part.Shape).d}\"/>")
        return sb.append("</g>").toString()
    }
}
