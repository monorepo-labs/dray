package com.yogesh.dray.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.CameraAlt
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import com.yogesh.dray.net.PairLink
import com.yogesh.dray.net.parseConnectLine
import com.yogesh.dray.net.socketUrl
import java.util.concurrent.Executors

/**
 * Add server: scan the pairing QR, or paste the address and token. A link from anywhere fills
 * this in but never adds a server unasked; Add does.
 */
@Composable
fun AddServerScreen(link: PairLink?, scanFirst: Boolean, done: () -> Unit) {
    val store = LocalStore.current
    var address by rememberSaveable { mutableStateOf(link?.url ?: "") }
    var token by rememberSaveable { mutableStateOf(link?.token ?: "") }
    var name by rememberSaveable { mutableStateOf(link?.name ?: "") }
    var filled by rememberSaveable { mutableStateOf(link != null) }
    var scanning by rememberSaveable { mutableStateOf(scanFirst && link == null) }

    fun fill(l: PairLink) {
        address = l.url; token = l.token; name = l.name ?: ""; filled = true
    }

    if (scanning) {
        ScanScreen({ fill(it); scanning = false }) { scanning = false }
        return
    }
    val parsed = parseConnectLine("${address.trim()} ${token.trim()}")
    val existing = parsed?.let { store.saved(it.first, it.second) }
    Column(Modifier.fillMaxSize().background(Dray.page).statusBarsPadding().navigationBarsPadding()) {
        Row(Modifier.fillMaxWidth().height(56.dp).padding(end = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(done) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Cancel", tint = Dray.text) }
            Text("Add server", Modifier.weight(1f), style = Dray.Font.headline)
            Text(
                if (existing == null) "Add" else "Update",
                Modifier.clip(RoundedCornerShape(8.dp)).clickable(enabled = parsed != null) {
                    val (url, tok) = parsed ?: return@clickable
                    val host = socketUrl(url)?.let { android.net.Uri.parse(it).host }
                    store.addServer(name.trim().ifEmpty { host ?: "Server" }, url, tok)
                    done()
                }.padding(horizontal = 12.dp, vertical = 8.dp),
                style = Dray.Font.pill.copy(color = if (parsed != null) Dray.text else Dray.tertiary),
            )
        }
        Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(Dray.Radius.lg)).background(Dray.card).clickable { scanning = true }.padding(16.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                Icon(Icons.Outlined.QrCodeScanner, null, Modifier.size(28.dp), tint = Dray.text)
                Column {
                    Text("Scan QR code", style = Dray.Font.headline)
                    Text("From dray server pair or Remote access.", style = Dray.Font.footnote.copy(color = Dray.secondary))
                }
            }
            Text("Or paste it", Modifier.padding(start = 4.dp, top = 12.dp), style = Dray.Font.footnote.copy(color = Dray.tertiary))
            Column(Modifier.clip(RoundedCornerShape(Dray.Radius.lg)).background(Dray.card)) {
                Field("Address", address, "wss:// or ws://host:port", KeyboardType.Uri) { text ->
                    // A whole connect line pasted here fills both at once.
                    val line = parseConnectLine(text)
                    PairLink.parse(text)?.let { fill(it) } ?: if (line != null && line.first != text) {
                        address = line.first; token = line.second; filled = true
                    } else address = text
                }
                HorizontalDivider(color = Dray.hairline, modifier = Modifier.padding(start = 16.dp))
                Field("Token", token, "64 characters", KeyboardType.Ascii) { token = it }
                HorizontalDivider(color = Dray.hairline, modifier = Modifier.padding(start = 16.dp))
                Field("Name", name, "Optional", KeyboardType.Text) { name = it }
            }
            Text(
                when {
                    existing != null -> "This server is already added as ${existing.name}."
                    filled -> "Filled from the pasted connect line."
                    else -> "A whole connect line fills both at once."
                },
                Modifier.padding(horizontal = 4.dp),
                style = Dray.Font.footnote.copy(color = Dray.tertiary),
            )
        }
    }
}

@Composable
private fun Field(label: String, value: String, prompt: String, type: KeyboardType, onChange: (String) -> Unit) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, Modifier.width(84.dp), style = Dray.Font.body)
        Box(Modifier.weight(1f)) {
            if (value.isEmpty()) Text(prompt, style = Dray.Font.body.copy(color = Dray.tertiary))
            BasicTextField(
                value, onChange, Modifier.fillMaxWidth(),
                textStyle = Dray.Font.body,
                singleLine = true,
                cursorBrush = SolidColor(Dray.text),
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, keyboardType = type),
            )
        }
    }
}

/** The camera, looking for a pairing QR. Answers the first one it reads; any other code is ignored. */
@Composable
private fun ScanScreen(onScan: (PairLink) -> Unit, cancel: () -> Unit) {
    val context = LocalContext.current
    var allowed by remember {
        mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED)
    }
    var asked by remember { mutableStateOf(false) }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { allowed = it; asked = true }
    LaunchedEffect(Unit) { if (!allowed) ask.launch(Manifest.permission.CAMERA) }
    Box(Modifier.fillMaxSize().background(Dray.page)) {
        when {
            allowed -> {
                CameraScanner(onScan)
                Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
                    Viewfinder()
                    Text("Point at the pairing code", Modifier.padding(top = 36.dp), style = Dray.Font.subhead)
                    Text("Run dray server pair on the server.", Modifier.padding(top = 4.dp), style = Dray.Font.footnote.copy(color = Dray.secondary))
                }
            }
            asked -> Column(Modifier.align(Alignment.Center).padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(Icons.Outlined.CameraAlt, null, Modifier.size(36.dp), tint = Dray.tertiary)
                Text("Can't use the camera", style = Dray.Font.title)
                Text("Allow Dray to use the camera in Settings, or type the address and token instead.",
                    style = Dray.Font.subhead.copy(color = Dray.secondary), textAlign = TextAlign.Center)
            }
        }
        Row(Modifier.statusBarsPadding().fillMaxWidth().height(56.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(cancel) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Cancel", tint = Dray.text) }
            Text("Scan QR code", style = Dray.Font.headline)
            Spacer(Modifier.weight(1f))
        }
    }
}

/** The four corners the code is aimed into, drawn on a 240dp square. */
@Composable
private fun Viewfinder() {
    Canvas(Modifier.size(240.dp)) {
        val s = size.width / 240f
        val inset = 4 * s
        val arm = 44 * s
        val radius = 20 * s
        val p = Path()
        for ((x, y, dx, dy) in listOf(listOf(0f, 0f, 1f, 1f), listOf(size.width, 0f, -1f, 1f), listOf(size.width, size.height, -1f, -1f), listOf(0f, size.height, 1f, -1f))) {
            val cx = x + dx * inset
            val cy = y + dy * inset
            p.moveTo(cx, cy + dy * arm)
            p.lineTo(cx, cy + dy * radius)
            p.quadraticTo(cx, cy, cx + dx * radius, cy)
            p.lineTo(cx + dx * arm, cy)
        }
        drawPath(p, Dray.text, style = Stroke(5.dp.toPx(), cap = StrokeCap.Round))
    }
}

@androidx.annotation.OptIn(androidx.camera.core.ExperimentalGetImage::class)
@Composable
private fun CameraScanner(onScan: (PairLink) -> Unit) {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    val executor = remember { Executors.newSingleThreadExecutor() }
    val scanner = remember { BarcodeScanning.getClient(BarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()) }
    var done by remember { mutableStateOf(false) }
    DisposableEffect(Unit) { onDispose { executor.shutdown(); scanner.close() } }
    AndroidView(
        factory = { ctx ->
            val view = PreviewView(ctx)
            val future = ProcessCameraProvider.getInstance(ctx)
            future.addListener({
                val provider = future.get()
                val preview = Preview.Builder().build().also { it.surfaceProvider = view.surfaceProvider }
                val analysis = ImageAnalysis.Builder().setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build()
                analysis.setAnalyzer(executor) { proxy ->
                    val media = proxy.image ?: return@setAnalyzer proxy.close()
                    scanner.process(InputImage.fromMediaImage(media, proxy.imageInfo.rotationDegrees))
                        .addOnSuccessListener { codes ->
                            val link = codes.firstNotNullOfOrNull { c -> c.rawValue?.let { PairLink.parse(it) } }
                            if (link != null && !done) {
                                done = true
                                provider.unbindAll()
                                onScan(link)
                            }
                        }
                        .addOnCompleteListener { proxy.close() }
                }
                runCatching {
                    provider.unbindAll()
                    provider.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
                }
            }, ContextCompat.getMainExecutor(ctx))
            view
        },
        modifier = Modifier.fillMaxSize(),
    )
}
