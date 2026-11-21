package com.yogesh.dray.ui

import androidx.annotation.OptIn
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.VideoSize
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.PlayerView
import com.yogesh.dray.net.http

/**
 * A browser recording a message names, played in place. The token rides `/file`'s query, as on
 * iOS, where the images send a header: one URL the player can hand around whole. Paused until tapped,
 * and the first frame shows as its poster.
 */
@OptIn(UnstableApi::class)
@Composable
fun RecordingPlayer(path: String) {
    val store = LocalStore.current
    val server = LocalImageServer.current
    val context = LocalContext.current
    val url = server?.let { store.fileUrl(it, path, withToken = true) }
    var ratio by remember(path) { mutableFloatStateOf(16f / 10f) }
    var failed by remember(path) { mutableStateOf(url == null) }
    // The same player moves to a full screen dialog and back: one stream, one position.
    var full by remember(path) { mutableStateOf(false) }
    var inline by remember(path) { mutableStateOf<PlayerView?>(null) }
    if (failed || url == null) {
        Text(path, style = Dray.Font.footnote.copy(color = Dray.secondary))
        return
    }
    val player = remember(url) {
        ExoPlayer.Builder(context)
            .setMediaSourceFactory(DefaultMediaSourceFactory(OkHttpDataSource.Factory(http)))
            .build().apply {
                setMediaItem(MediaItem.fromUri(url))
                playWhenReady = false
                prepare()
            }
    }
    DisposableEffect(player) {
        val listener = object : Player.Listener {
            override fun onVideoSizeChanged(size: VideoSize) {
                if (size.width > 0 && size.height > 0) ratio = size.width.toFloat() / size.height
            }
            override fun onPlayerError(error: PlaybackException) {
                failed = true
            }
        }
        player.addListener(listener)
        onDispose {
            player.removeListener(listener)
            player.release()
        }
    }
    Box(
        Modifier
            .widthIn(max = 480.dp)
            .fillMaxWidth()
            .aspectRatio(ratio)
            .clip(RoundedCornerShape(Dray.Radius.md))
            .background(Dray.well),
    ) {
        AndroidView(
            factory = { ctx ->
                playerView(ctx) { if (it) full = true }.also { v -> v.player = player; inline = v }
            },
            modifier = Modifier.fillMaxWidth().aspectRatio(ratio),
        )
    }
    // Android 15 draws the dialog under the gesture bar and dispatches it no insets, so the activity's are carried in.
    val bars = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    if (full) Dialog({ full = false }, DialogProperties(usePlatformDefaultWidth = false)) {
        var big by remember { mutableStateOf<PlayerView?>(null) }
        // Media3's own handoff: the surface moves with the player, so neither view is left drawing a stale one.
        DisposableEffect(Unit) {
            onDispose {
                PlayerView.switchTargetView(player, big, inline)
                inline?.setFullscreenButtonState(false)
                redraw(player)
            }
        }
        Box(Modifier.fillMaxSize().background(Color.Black), contentAlignment = Alignment.Center) {
            AndroidView(
                factory = { ctx ->
                    playerView(ctx) { if (!it) full = false }.also { v ->
                        v.setFullscreenButtonState(true)
                        PlayerView.switchTargetView(player, inline, v)
                        redraw(player)
                        big = v
                    }
                },
                modifier = Modifier.fillMaxSize().padding(bottom = bars),
            )
        }
    }
}

/** A paused player paints nothing onto a surface it just moved to; a seek in place renders the frame again. */
private fun redraw(player: Player) {
    if (!player.isPlaying) player.seekTo(player.currentPosition)
}

/**
 * Media3's own controls with its full screen button. `toggle` gets the state the button moved to;
 * each view acts on its own direction alone, since the new view also reports the press that opened it.
 */
@OptIn(UnstableApi::class)
private fun playerView(context: android.content.Context, toggle: (Boolean) -> Unit) = PlayerView(context).apply {
    useController = true
    setShowNextButton(false)
    setShowPreviousButton(false)
    setFullscreenButtonClickListener { toggle(it) }
}
