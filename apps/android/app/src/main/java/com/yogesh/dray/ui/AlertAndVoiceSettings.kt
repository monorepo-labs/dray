package com.yogesh.dray.ui

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material.icons.outlined.PhoneAndroid
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.core.content.ContextCompat
import com.yogesh.dray.push.Push
import com.yogesh.dray.voice.DictationEngine
import com.yogesh.dray.voice.Dictations
import com.yogesh.dray.voice.PhoneSpeech
import com.yogesh.dray.voice.canDictate
import com.yogesh.dray.voice.dictationEngine

/**
 * The main switch, then one per kind of alert. The servers send only the kinds left on; Android
 * having Dray's notifications off is said, since no switch here can undo it.
 */
@Composable
fun NotificationSettings(back: () -> Unit) {
    val context = LocalContext.current
    var blocked by remember { mutableStateOf(!Push.allowedBySystem()) }
    var kinds by remember { mutableStateOf(Push.kinds.associate { it.first to Push.kindOn(it.first) }) }
    // Back from Android's own settings is where the answer changes.
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { blocked = !Push.allowedBySystem() }

    SettingsPage("Notifications", back) {
        if (!Push.available) {
            Text(
                "Push isn't set up in this build of Dray.",
                Modifier.padding(horizontal = 4.dp),
                style = Dray.Font.footnote.copy(color = Dray.secondary),
            )
            return@SettingsPage
        }
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            RowGroup { SwitchRow("Allow notifications", Push.enabled) { Push.set(it) } }
            if (Push.enabled && blocked) {
                Text(
                    "Android has notifications off for Dray. Turn them on in Settings.",
                    Modifier.padding(horizontal = 4.dp).clickable {
                        context.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                            .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName))
                    },
                    style = Dray.Font.footnote.copy(color = Dray.secondary),
                )
            }
        }
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            GroupLabel("Tell me when")
            RowGroup(Modifier.alpha(if (Push.enabled) 1f else 0.45f)) {
                Push.kinds.forEachIndexed { i, (kind, label) ->
                    if (i > 0) HorizontalDivider(color = Dray.hairline, modifier = Modifier.padding(start = 16.dp))
                    SwitchRow(label, kinds[kind] == true, enabled = Push.enabled) { on ->
                        Push.setKind(kind, on)
                        kinds = kinds + (kind to on)
                    }
                }
            }
            GroupLabel("A bot's own tasks stay quiet: the bot tells you about them.")
        }
    }
}

/** A Settings page under Settings: back, its title, and its groups scrolling under them. */
@Composable
private fun SettingsPage(title: String, back: () -> Unit, content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxSize().background(Dray.page).statusBarsPadding().navigationBarsPadding()) {
        Row(Modifier.fillMaxWidth().height(56.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(back) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back", tint = Dray.text) }
            Text(title, style = Dray.Font.headline)
        }
        Column(
            Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(28.dp),
            content = content,
        )
    }
}

@Composable
private fun RowGroup(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Column(modifier.fillMaxWidth().clip(RoundedCornerShape(Dray.Radius.lg)).background(Dray.card), content = content)
}

@Composable
private fun GroupLabel(text: String) {
    Text(text, Modifier.padding(horizontal = 4.dp), style = Dray.Font.footnote.copy(color = Dray.tertiary))
}

@Composable
private fun SwitchRow(label: String, on: Boolean, enabled: Boolean = true, set: (Boolean) -> Unit) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 52.dp).clickable(enabled = enabled) { set(!on) }.padding(start = 16.dp, end = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, Modifier.weight(1f), style = Dray.Font.body)
        Switch(on, set, enabled = enabled, colors = SwitchDefaults.colors(
            checkedTrackColor = Dray.primary, checkedThumbColor = Dray.onPrimary, uncheckedTrackColor = Dray.off,
            uncheckedThumbColor = Dray.secondary, uncheckedBorderColor = Dray.off))
    }
}

/**
 * What turns the phone's voice into text — Android's recognizer on the phone or a server — the
 * record tones, and the microphone's permission. Settings.swift's `DictationSettings`.
 */
@Composable
fun DictationSettings(back: () -> Unit) {
    val store = LocalStore.current
    val context = LocalContext.current
    var mic by remember { mutableStateOf(micAllowed(context)) }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) {
        mic = micAllowed(context)
        Dictations.refreshPhone()
    }
    val chosen = store.dictationEngine(Dictations.pick)
    val onDevice = remember { PhoneSpeech.onDevice(context) }
    val service = remember { PhoneSpeech.serviceName(context) }

    SettingsPage("Dictation", back) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            GroupLabel("Transcribe on")
            RowGroup {
                EngineRow(
                    "This phone",
                    when {
                        !Dictations.phoneUsable -> "No speech service on this phone"
                        onDevice -> "On device, private"
                        else -> "Through ${service ?: "the phone's speech service"}"
                    },
                    able = Dictations.phoneUsable, chosen = chosen == DictationEngine.Phone,
                    icon = { Icon(Icons.Outlined.PhoneAndroid, null, Modifier.size(20.dp), tint = Dray.secondary) },
                ) { Dictations.choose(PhoneSpeech.PICK) }
                for (s in store.servers) {
                    HorizontalDivider(color = Dray.hairline, modifier = Modifier.padding(start = 52.dp))
                    EngineRow(
                        s.name, null, able = store.canDictate(s.id), chosen = chosen == DictationEngine.Server(s.id),
                        icon = { Icon(Icons.Outlined.Dns, null, Modifier.size(20.dp), tint = Dray.secondary) },
                    ) { Dictations.choose(s.id) }
                }
            }
            when (chosen) {
                DictationEngine.Phone -> GroupLabel(
                    if (onDevice) "Your voice is turned into text on this phone and never leaves it."
                    else "Your voice is turned into text by ${service ?: "the phone's speech service"}, which may send it to its maker.",
                )
                is DictationEngine.Server -> GroupLabel("Your voice is turned into text on this server.")
                null -> {}
            }
        }
        RowGroup {
            SwitchRow("Start and stop sounds", Dictations.sounds) { Dictations.playSounds(it) }
            HorizontalDivider(color = Dray.hairline, modifier = Modifier.padding(start = 16.dp))
            Row(
                Modifier.fillMaxWidth().heightIn(min = 52.dp).clickable {
                    context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null)))
                }.padding(start = 16.dp, end = 16.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("Microphone", Modifier.weight(1f), style = Dray.Font.body)
                Text(if (mic) "Allowed" else "Not allowed", style = Dray.Font.body.copy(color = Dray.tertiary))
                Icon(Icons.AutoMirrored.Outlined.OpenInNew, null, Modifier.padding(start = 8.dp).size(16.dp), tint = Dray.tertiary)
            }
        }
    }
}

private fun micAllowed(context: Context) =
    ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

@Composable
private fun EngineRow(name: String, detail: String?, able: Boolean, chosen: Boolean, icon: @Composable () -> Unit, pick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 52.dp).clickable(enabled = able, onClick = pick)
            .padding(start = 16.dp, end = 14.dp, top = if (detail == null) 0.dp else 8.dp, bottom = if (detail == null) 0.dp else 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Box(Modifier.alpha(if (able) 1f else 0.45f)) { icon() }
        Column(Modifier.weight(1f)) {
            Text(name, style = Dray.Font.body.copy(color = if (able) Dray.text else Dray.tertiary), maxLines = 1)
            if (detail != null) Text(detail, style = Dray.Font.footnote.copy(color = Dray.tertiary))
        }
        if (!able && detail == null) Text("Unavailable", style = Dray.Font.body.copy(color = Dray.tertiary))
        else if (chosen) Icon(Icons.Filled.Check, "Chosen", Modifier.size(20.dp), tint = Dray.text)
    }
}

/**
 * Android 13 and up ask before any alert shows. Asked once a server is up and push wants a token,
 * as iOS asks at the first connect; turned down, push stays quiet until Settings' switch asks again.
 */
@Composable
fun NotificationAsk() {
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { Push.permissionAnswered(it) }
    LaunchedEffect(Push.wantsPermission) {
        if (Push.wantsPermission && Build.VERSION.SDK_INT >= 33) ask.launch(Manifest.permission.POST_NOTIFICATIONS)
    }
}
