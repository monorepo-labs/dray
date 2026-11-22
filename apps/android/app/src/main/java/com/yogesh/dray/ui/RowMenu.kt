package com.yogesh.dray.ui

import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.outlined.CallSplit
import androidx.compose.material.icons.automirrored.outlined.Undo
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.outlined.Archive
import androidx.compose.material.icons.outlined.DeleteOutline
import androidx.compose.material.icons.outlined.Done
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.LinkOff
import androidx.compose.material.icons.outlined.MarkChatUnread
import androidx.compose.material.icons.outlined.PushPin
import androidx.compose.material.icons.outlined.Unarchive
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.dp
import com.yogesh.dray.model.ListRow
import com.yogesh.dray.model.SessionKey
import com.yogesh.dray.store.attach
import com.yogesh.dray.store.attachTargets
import com.yogesh.dray.store.delete
import com.yogesh.dray.store.detach
import com.yogesh.dray.store.fork
import com.yogesh.dray.store.markUnread
import com.yogesh.dray.store.setFlags
import kotlinx.coroutines.launch

private enum class MenuPage { Main, Fork, Attach }

/**
 * A task row's long-press menu: the desktop sidebar's `RowMenu`, each item shown where it shows
 * there. Settle lives here, since a phone row has no hover button to carry it. A submenu swaps
 * the menu's items in place, as Android's own popup menus do.
 *
 * `aside`: drawn in the set-aside run or flagged aside, so the item turns to Bring back.
 * `inheritsPin`: in Pinned only through an ancestor, where a pin would move nothing and leave a flag behind.
 */
@Composable
fun RowMenu(
    expanded: Boolean,
    dismiss: () -> Unit,
    row: ListRow,
    aside: Boolean,
    inheritsPin: Boolean,
    opened: (SessionKey) -> Unit,
    delete: () -> Unit,
) {
    val store = LocalStore.current
    val haptics = LocalHapticFeedback.current
    var page by remember { mutableStateOf(MenuPage.Main) }
    LaunchedEffect(expanded) { if (expanded) page = MenuPage.Main }
    val key = row.key
    val item = row.item
    val settled = item.archived == true
    // The store's scope: a settle or attach takes the row, and this menu with it, off the list before the reply lands.
    fun act(block: suspend () -> Unit) {
        dismiss()
        store.scope.launch { block() }
    }
    fun set(vararg flags: Pair<String, Boolean>) = act { store.setFlags(key, mapOf(*flags)) }

    DropdownMenu(expanded, dismiss, offset = DpOffset(20.dp, 0.dp), containerColor = Dray.raised) {
        when (page) {
            MenuPage.Fork -> {
                Back("Fork") { page = MenuPage.Main }
                // Two because they differ in where the copy runs, not what it copies.
                Item("Fork in new worktree") { act { store.fork(key, worktree = true)?.let(opened) } }
                Item("Fork here") { act { store.fork(key, worktree = false)?.let(opened) } }
            }
            MenuPage.Attach -> {
                Back("Attach to bot") { page = MenuPage.Main }
                for (bot in store.attachTargets(key, item)) DropdownMenuItem(
                    text = { Text(bot.name, style = Dray.Font.body) },
                    leadingIcon = { BotFace(bot, size = 22.dp) },
                    onClick = { act { if (store.attach(key, bot)) haptics.performHapticFeedback(HapticFeedbackType.LongPress) } },
                )
            }
            MenuPage.Main -> {
                // Off mid-turn: the copy would inherit half a turn, and the server refuses it too.
                Item("Fork", Icons.AutoMirrored.Outlined.CallSplit, enabled = !item.busy, more = true) { page = MenuPage.Fork }
                // A settled list draws no Pinned run and no aside run, so neither verb would move anything there.
                if (!settled && !inheritsPin) {
                    val pinned = item.pinned == true
                    Item(if (pinned) "Unpin" else "Pin", if (pinned) Icons.Filled.PushPin else Icons.Outlined.PushPin) {
                        // Pinning an aside row brings it back, or it would stay faded below.
                        if (item.aside == true && !pinned) set("pinned" to true, "aside" to false) else set("pinned" to !pinned)
                    }
                }
                if (!settled) Item(if (aside) "Bring back" else "Set aside", if (aside) Icons.Outlined.Unarchive else Icons.Outlined.Archive) {
                    // Setting aside unpins, or the row would stay up in Pinned.
                    if (aside) set("aside" to false) else set("aside" to true, "pinned" to false)
                }
                // Only a read, finished session; a lazy fork has run nothing to read.
                if (item.status == "idle" && !settled && item.forkFrom == null) {
                    Item("Mark unread", Icons.Outlined.MarkChatUnread) { act { store.markUnread(key) } }
                }
                // Never mid-turn: settling stops the child, and the turn would die with nothing saying so.
                if (settled) Item("Unsettle", Icons.AutoMirrored.Outlined.Undo) { set("archived" to false) }
                else if (!item.busy) Item("Settle", Icons.Outlined.Done) {
                    haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                    set("archived" to true)
                }
                if (row.depth > 0) Item("Detach from parent", Icons.Outlined.LinkOff) { act { store.detach(key) } }
                // One bot is named on the item itself; a submenu only where there is a choice.
                val bots = store.attachTargets(key, item)
                if (bots.size == 1) {
                    val bot = bots.first()
                    DropdownMenuItem(
                        text = { Text("Attach to ${bot.name}", style = Dray.Font.body) },
                        leadingIcon = { BotFace(bot, size = 22.dp) },
                        onClick = { act { if (store.attach(key, bot)) haptics.performHapticFeedback(HapticFeedbackType.LongPress) } },
                    )
                } else if (bots.isNotEmpty()) Item("Attach to bot", Icons.Outlined.Link, more = true) { page = MenuPage.Attach }
                HorizontalDivider(color = Dray.border)
                Item("Delete", Icons.Outlined.DeleteOutline, color = Dray.destructive) { dismiss(); delete() }
            }
        }
    }
}

@Composable
private fun Item(
    label: String,
    icon: ImageVector? = null,
    enabled: Boolean = true,
    more: Boolean = false,
    color: Color = Dray.text,
    onClick: () -> Unit,
) {
    val tint = if (enabled) color else Dray.tertiary
    DropdownMenuItem(
        text = { Text(label, style = Dray.Font.body.copy(color = tint)) },
        leadingIcon = icon?.let { { Icon(it, null, Modifier.size(20.dp), tint = tint) } },
        trailingIcon = if (more) ({ Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, Modifier.size(20.dp), tint = Dray.tertiary) }) else null,
        enabled = enabled,
        onClick = onClick,
    )
}

/** A submenu's first line: its title, and the way back to the menu it opened from. */
@Composable
private fun Back(title: String, onClick: () -> Unit) {
    DropdownMenuItem(
        text = { Text(title, style = Dray.Font.footnoteStrong.copy(color = Dray.secondary)) },
        leadingIcon = { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back", Modifier.size(18.dp), tint = Dray.secondary) },
        onClick = onClick,
    )
}

/** Delete's confirm, asked apart from the menu, which closes on any pick. */
@Composable
fun DeleteConfirm(row: ListRow, close: () -> Unit) {
    val store = LocalStore.current
    val haptics = LocalHapticFeedback.current
    AlertDialog(
        onDismissRequest = close,
        containerColor = Dray.card,
        title = { Text("Delete “${row.item.title.ifEmpty { "Untitled" }}”?", style = Dray.Font.headline) },
        text = { Text("Its conversation goes for good.", style = Dray.Font.subhead.copy(color = Dray.secondary)) },
        confirmButton = {
            TextButton({
                close()
                // The store's scope, since closing takes this dialog's own with it.
                store.scope.launch { if (!store.delete(row.key)) haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove) }
            }) { Text("Delete", color = Dray.destructive) }
        },
        dismissButton = { TextButton(close) { Text("Cancel", color = Dray.secondary) } },
    )
}
