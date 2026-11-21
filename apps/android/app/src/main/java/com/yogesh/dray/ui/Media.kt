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
import androidx.compose.ui.Modifier
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
            factory = { PlayerView(it).apply { this.player = player; useController = true; setShowNextButton(false); setShowPreviousButton(false) } },
            modifier = Modifier.fillMaxWidth().aspectRatio(ratio),
        )
    }
}
