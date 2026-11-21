package com.yogesh.dray.ui

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.ui.input.pointer.positionChanged
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.activity.compose.BackHandler
import com.yogesh.dray.model.Shot
import kotlinx.coroutines.launch
import kotlin.math.abs

/**
 * A tapped picture full screen among the rest of its turn's: swipe or the strip to page, pinch
 * or double-tap to zoom, drag down to close.
 */
@Composable
fun ImageViewer(shots: List<Shot>, start: Int, close: () -> Unit) {
    val pager = rememberPagerState(start) { shots.size }
    val scope = rememberCoroutineScope()
    var zoomed by remember { mutableStateOf(false) }
    var pull by remember { mutableFloatStateOf(0f) }
    val settle by animateFloatAsState(pull, label = "pull")
    BackHandler(onBack = close)
    run {
        Box(Modifier.fillMaxSize().pointerInput(Unit) {}.background(Dray.page.copy(alpha = 1f - (abs(settle) / 400f).coerceIn(0f, 1f) * 0.55f))) {
            HorizontalPager(
                pager,
                Modifier.fillMaxSize().pointerInput(zoomed) {
                    if (zoomed) return@pointerInput
                    detectVerticalDragGestures(
                        onDragEnd = { if (abs(pull) > 120.dp.toPx()) close() else pull = 0f },
                        onDragCancel = { pull = 0f },
                    ) { _, dy -> pull += dy }
                },
                userScrollEnabled = !zoomed,
                beyondViewportPageCount = 1,
            ) { page ->
                ZoomableImage(shots[page], Modifier.graphicsLayer { translationY = settle }) { zoomed = it }
            }
            val chrome by animateFloatAsState(if (zoomed || pull != 0f) 0f else 1f, label = "chrome")
            Column(Modifier.fillMaxSize().alpha(chrome)) {
                Row(Modifier.statusBarsPadding().fillMaxWidth().height(56.dp).padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(44.dp).clip(CircleShape).background(Dray.raised.copy(alpha = 0.8f)).clickable(onClick = close), contentAlignment = Alignment.Center) {
                        Icon(Icons.Filled.Close, "Close", tint = Dray.text)
                    }
                    Spacer(Modifier.weight(1f))
                    Text("${pager.currentPage + 1} of ${shots.size}", style = Dray.Font.subhead)
                    Spacer(Modifier.weight(1f))
                    Spacer(Modifier.size(44.dp))
                }
                Spacer(Modifier.weight(1f))
                Column(Modifier.navigationBarsPadding().padding(bottom = 10.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(18.dp)) {
                    if (shots.size > 1) {
                        val strip = rememberLazyListState()
                        LaunchedEffect(pager.currentPage) { strip.animateScrollToItem((pager.currentPage - 2).coerceAtLeast(0)) }
                        LazyRow(state = strip, contentPadding = PaddingValues(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            itemsIndexed(shots) { i, shot ->
                                val current = i == pager.currentPage
                                Box(
                                    Modifier
                                        .size(48.dp)
                                        .then(if (current) Modifier.border(1.5.dp, Dray.text, RoundedCornerShape(Dray.Radius.sm + 2.dp)).padding(2.dp) else Modifier.padding(2.dp))
                                        .alpha(if (current) 1f else 0.45f)
                                        .clip(RoundedCornerShape(Dray.Radius.sm))
                                        .clickable { scope.launch { pager.animateScrollToPage(i) } },
                                ) { RemoteImage(shot.ref, Modifier.fillMaxSize(), ContentScale.Crop) }
                            }
                        }
                    }
                    val shot = shots[pager.currentPage]
                    Row(Modifier.padding(horizontal = 24.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(shot.verb, style = Dray.Font.footnote.copy(color = Dray.secondary))
                        shot.target?.let { Text(it, style = Dray.Font.footnote.copy(color = Dray.tertiary), maxLines = 1, overflow = TextOverflow.Ellipsis) }
                    }
                }
            }
        }
    }
}

/** One page: pinch up to 4×, double-tap to 2.5× where tapped and back; panning only while zoomed. */
@Composable
private fun ZoomableImage(shot: Shot, modifier: Modifier, onZoom: (Boolean) -> Unit) {
    var scale by remember { mutableFloatStateOf(1f) }
    var offset by remember { mutableStateOf(Offset.Zero) }
    Box(
        modifier
            .fillMaxSize()
            .pointerInput(Unit) {
                detectTapGestures(onDoubleTap = { at ->
                    if (scale > 1f) { scale = 1f; offset = Offset.Zero } else {
                        scale = 2.5f
                        offset = (Offset(size.width / 2f, size.height / 2f) - at) * 1.5f
                    }
                    onZoom(scale > 1f)
                })
            }
            .pointerInput(Unit) {
                awaitEachGesture {
                    awaitFirstDown(requireUnconsumed = false)
                    do {
                        val event = awaitPointerEvent()
                        // At 1× a one-finger drag belongs to the pager and the pull-to-close.
                        if (event.changes.size < 2 && scale == 1f) continue
                        scale = (scale * event.calculateZoom()).coerceIn(1f, 4f)
                        offset = if (scale == 1f) Offset.Zero else offset + event.calculatePan()
                        onZoom(scale > 1f)
                        event.changes.forEach { if (it.positionChanged()) it.consume() }
                    } while (event.changes.any { it.pressed })
                }
            },
        contentAlignment = Alignment.Center,
    ) {
        RemoteImage(
            shot.ref,
            Modifier.fillMaxSize().graphicsLayer { scaleX = scale; scaleY = scale; translationX = offset.x; translationY = offset.y },
        )
    }
}
