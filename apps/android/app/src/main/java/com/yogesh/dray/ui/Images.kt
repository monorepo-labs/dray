package com.yogesh.dray.ui

import android.graphics.BitmapFactory
import android.util.Base64
import android.util.LruCache
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.yogesh.dray.net.ConnState
import com.yogesh.dray.net.http
import com.yogesh.dray.store.Store
import com.yogesh.dray.wire.ImageRef
import com.yogesh.dray.wire.get
import com.yogesh.dray.wire.jsonOf
import com.yogesh.dray.wire.str
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import okhttp3.Request

val LocalStore = staticCompositionLocalOf<Store> { error("No store") }

/** The server a transcript's images are read from. */
val LocalImageServer = staticCompositionLocalOf<String?> { null }

/** Opens a picture full screen, among the rest of its turn's where one is to hand. */
val LocalOpenImage = staticCompositionLocalOf<(ImageRef) -> Unit> { {} }

/**
 * Pictures held in memory only, one fetch per key at a time, owned by the app rather than any
 * row: a row that leaves and comes back mid-load waits on the same read instead of cancelling it.
 */
object ImageLoader {
    private val cache = object : LruCache<String, ImageBitmap>(64 * 1024 * 1024) {
        override fun sizeOf(key: String, value: ImageBitmap) = value.width * value.height * 4
    }
    private val inFlight = mutableMapOf<String, Deferred<ImageBitmap?>>()

    /** A web or `data:` URL is the same picture everywhere; anything else is a file on one server, so the server is in its key. */
    fun key(server: String?, ref: ImageRef): String {
        val url = ref.url
        if (ref.path == null && url != null && (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("data:"))) return url
        return "$server|${ref.path ?: url ?: ""}"
    }

    fun cached(server: String?, ref: ImageRef): ImageBitmap? = cache.get(key(server, ref))

    /** Reads one picture. Main thread in, main thread out; the network and decode run off it. */
    suspend fun load(store: Store, server: String?, ref: ImageRef): ImageBitmap? {
        val key = key(server, ref)
        cache.get(key)?.let { return it }
        val running = inFlight[key] ?: store.scope.async {
            try {
                fetch(store, server, ref)?.also { cache.put(key, it) }
            } finally {
                inFlight.remove(key)
            }
        }.also { inFlight[key] = it }
        return running.await()
    }

    private suspend fun fetch(store: Store, server: String?, ref: ImageRef): ImageBitmap? {
        val url = ref.url
        if (ref.path == null && url != null) {
            if (url.startsWith("data:")) return decodeBase64(url)
            if (url.startsWith("http://") || url.startsWith("https://")) return get(url, null)
        }
        val path = ref.path ?: url ?: return null
        server ?: return null
        val token = store.token(server)
        val fileUrl = store.fileUrl(server, path)
        // `/file` serves attachments and recordings only; any other path is read through the socket.
        fileUrl?.let { u -> get(u, token)?.let { return it } }
        val read = runCatching { store.call(server, "read_file", jsonOf("path" to path.removePrefix("file://"))) }.getOrNull()
        val dataUrl = read["dataUrl"].str ?: return null
        return decodeBase64(dataUrl)
    }

    /** A `data:` URL's picture. Its text comes from a transcript, so a malformed one is a picture that fails, never a crash. */
    private suspend fun decodeBase64(dataUrl: String): ImageBitmap? = withContext(Dispatchers.Default) {
        runCatching { decode(Base64.decode(dataUrl.substringAfter(","), Base64.DEFAULT)) }.getOrNull()
    }

    private suspend fun get(url: String, token: String?): ImageBitmap? = withContext(Dispatchers.IO) {
        runCatching {
            val req = Request.Builder().url(url).apply { token?.let { header("Authorization", "Bearer $it") } }.build()
            http.newCall(req).execute().use { r -> if (r.code == 200) r.body?.bytes()?.let { decode(it) } else null }
        }.getOrNull()
    }

    /** Decoded at most 2048px a side: a full-resolution screenshot is several times what a phone can show. */
    private fun decode(bytes: ByteArray): ImageBitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0) return null
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / sample > 2048) sample *= 2
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })?.asImageBitmap()
    }
}

/**
 * A picture from a server, retried at 0, 2, 5 and 15s and again whenever its server comes
 * back: a phone that left the network mid-read gets it on return.
 */
@Composable
fun RemoteImage(
    ref: ImageRef,
    modifier: Modifier = Modifier,
    contentScale: ContentScale = ContentScale.Fit,
    alignment: Alignment = Alignment.Center,
    fallback: String? = null,
    onLoaded: (ImageBitmap) -> Unit = {},
) {
    val store = LocalStore.current
    val server = LocalImageServer.current
    var bitmap by remember(ref, server) { mutableStateOf(ImageLoader.cached(server, ref)) }
    var failed by remember(ref, server) { mutableStateOf(false) }
    val up = server?.let { store.serverState[it] } == ConnState.Connected
    LaunchedEffect(ref, server, up) {
        // A cache hit is a load too: callers size or reveal themselves off this.
        bitmap?.let { onLoaded(it); return@LaunchedEffect }
        for (wait in listOf(0L, 2000L, 5000L, 15000L)) {
            delay(wait)
            val got = ImageLoader.load(store, server, ref)
            if (got != null) {
                bitmap = got
                failed = false
                onLoaded(got)
                return@LaunchedEffect
            }
            failed = true
        }
    }
    val b = bitmap
    when {
        b != null -> Image(b, "Image", modifier, alignment = alignment, contentScale = contentScale)
        failed && fallback != null -> Text(fallback, modifier, style = Dray.Font.footnote.copy(color = Dray.secondary))
        failed -> Box(modifier.background(Dray.primary.copy(alpha = 0.06f)), Alignment.Center) {
            Icon(Icons.Outlined.Image, null, tint = Dray.tertiary)
        }
        else -> Box(modifier.background(Dray.primary.copy(alpha = 0.06f)))
    }
}

/** A picture in a message: fit inside 320×320, left-aligned, opening full screen on a tap. */
@Composable
fun InlineImage(ref: ImageRef, fallback: String? = null) {
    val open = LocalOpenImage.current
    var ratio by remember(ref) { mutableStateOf<Float?>(null) }
    val shape = RoundedCornerShape(Dray.Radius.md)
    RemoteImage(
        ref,
        Modifier
            .widthIn(max = 320.dp)
            .heightIn(max = 320.dp)
            .then(ratio?.let { Modifier.aspectRatio(it, matchHeightConstraintsFirst = it < 1f) } ?: Modifier.size(160.dp, 100.dp))
            .clip(shape)
            .clickable { open(ref) }
            .semantics { contentDescription = "Open image" },
        alignment = Alignment.TopStart,
        fallback = fallback,
        onLoaded = { ratio = it.width.toFloat() / it.height.coerceAtLeast(1) },
    )
}

/**
 * A row of 72pt squares: a prompt's attachments, or a folded stretch's pictures. [sent] gives each
 * the desktop's hairline, which keeps a picture with a dark edge from melting into the page.
 */
@Composable
fun Thumbnails(refs: List<ImageRef>, end: Boolean = false, size: Dp = 72.dp, sent: Boolean = false) {
    if (refs.isEmpty()) return
    val open = LocalOpenImage.current
    val shape = RoundedCornerShape(Dray.Radius.md)
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(4.dp, if (end) Alignment.End else Alignment.Start),
    ) {
        for (ref in refs) {
            RemoteImage(
                ref,
                Modifier.size(size).clip(shape).then(if (sent) Modifier.border(0.5.dp, Dray.border, shape) else Modifier).clickable { open(ref) },
                contentScale = ContentScale.Crop,
            )
        }
    }
}
