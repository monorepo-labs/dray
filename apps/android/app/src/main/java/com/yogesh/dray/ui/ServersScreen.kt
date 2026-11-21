package com.yogesh.dray.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import com.yogesh.dray.net.ConnState
import com.yogesh.dray.store.Server

/**
 * The servers this phone follows: each one's state, its switch, Fix where its token was refused,
 * and removal. The rest of Settings lands on top of this.
 */
@Composable
fun ServersScreen(back: () -> Unit, add: () -> Unit, fix: (Server) -> Unit) {
    val store = LocalStore.current
    var removing by remember { mutableStateOf<Server?>(null) }
    Column(Modifier.fillMaxSize().background(Dray.page).statusBarsPadding().navigationBarsPadding()) {
        Row(Modifier.fillMaxWidth().height(56.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(back) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back", tint = Dray.text) }
            Text("Settings", style = Dray.Font.headline)
        }
        Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Servers", Modifier.padding(start = 4.dp), style = Dray.Font.footnote.copy(color = Dray.tertiary))
            Column(Modifier.clip(RoundedCornerShape(Dray.Radius.lg)).background(Dray.card)) {
                store.servers.forEachIndexed { i, s ->
                    if (i > 0) HorizontalDivider(color = Dray.hairline, modifier = Modifier.padding(start = 40.dp))
                    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                        val state = store.serverState[s.id]
                        Box(Modifier.size(8.dp).clip(CircleShape).background(when {
                            !s.on -> Dray.off
                            state == ConnState.Connected -> Dray.add
                            state is ConnState.Failed -> Dray.accent
                            else -> Dray.dim
                        }))
                        Column(Modifier.weight(1f).padding(start = 16.dp)) {
                            Text(s.name, style = Dray.Font.body)
                            Text(
                                if (s.via != null) "${store.stateLabel(s.id)} · through ${store.name(s.via.parent)}" else store.stateLabel(s.id),
                                style = Dray.Font.footnote.copy(color = Dray.tertiary),
                            )
                        }
                        if (s.via == null) {
                            if (store.health(s.id)?.action == Health.Action.Fix) {
                                Text("Fix", Modifier.clickable { fix(s) }.padding(8.dp), style = Dray.Font.pill.copy(color = Dray.accent))
                            }
                            Switch(s.on, { store.setServerOn(s.id, it) }, colors = SwitchDefaults.colors(
                                checkedTrackColor = Dray.primary, checkedThumbColor = Dray.onPrimary, uncheckedTrackColor = Dray.off,
                                uncheckedThumbColor = Dray.secondary, uncheckedBorderColor = Dray.off))
                            IconButton({ removing = s }) { Icon(Icons.Outlined.Delete, "Remove ${s.name}", tint = Dray.tertiary) }
                        }
                    }
                }
                if (store.servers.isNotEmpty()) HorizontalDivider(color = Dray.hairline)
                Row(Modifier.fillMaxWidth().clickable(onClick = add).padding(horizontal = 16.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Filled.Add, null, Modifier.size(20.dp), tint = Dray.text)
                    Text("Add server", Modifier.padding(start = 12.dp), style = Dray.Font.body)
                }
            }
        }
    }
    removing?.let { s ->
        AlertDialog(
            onDismissRequest = { removing = null },
            title = { Text("Remove ${s.name}?") },
            text = { Text("Its tasks keep running there. Pair again to see them.") },
            confirmButton = { TextButton({ store.removeServer(s); removing = null }) { Text("Remove", color = Dray.destructive) } },
            dismissButton = { TextButton({ removing = null }) { Text("Keep", color = Dray.text) } },
            containerColor = Dray.card,
        )
    }
}
