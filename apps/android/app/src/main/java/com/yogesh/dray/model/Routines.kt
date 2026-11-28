package com.yogesh.dray.model

import com.yogesh.dray.wire.Routine
import com.yogesh.dray.wire.parseDate
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.time.temporal.ChronoUnit
import java.util.Locale
import kotlin.math.roundToLong

// The desktop's routines.ts labels, as iOS's `Routine` spells them too.

private val DAYS = listOf("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")

/** "Every 2h", "Weekdays at 09:00", as the server's `describe` says it. */
fun scheduleLabel(r: Routine): String {
    val m = r.schedule.everyMinutes
    if (m != null && m > 0) return "Every " + if (m % 1440 == 0) "${m / 1440}d" else if (m % 60 == 0) "${m / 60}h" else "${m}m"
    val days = r.schedule.days.filter { it in 0..6 }.toSortedSet().toList()
    val on = when (days) {
        emptyList<Int>(), listOf(0, 1, 2, 3, 4, 5, 6) -> "Daily"
        listOf(0, 1, 2, 3, 4) -> "Weekdays"
        listOf(5, 6) -> "Weekends"
        else -> days.joinToString(", ") { DAYS[it] }
    }
    return "$on at ${r.schedule.at ?: "?"}"
}

/** "Paused", "Next in 34m", "Next 9:00 AM tomorrow", or "Due now" for one the server is about to fire. */
fun nextRunLabel(r: Routine, now: Long, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String {
    if (r.paused) return "Paused"
    val at = parseDate(r.nextRun) ?: return "Not scheduled"
    val min = ((at - now) / 60_000.0).roundToLong()
    if (min <= 0) return "Due now"
    if (min < 60) return "Next in ${min}m"
    val then = Instant.ofEpochMilli(at).atZone(zone)
    val time = then.format(DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(locale))
    // Calendar days, not a 24-hour distance: 11pm to 1am is two hours away and still "tomorrow".
    val days = ChronoUnit.DAYS.between(Instant.ofEpochMilli(now).atZone(zone).toLocalDate(), then.toLocalDate())
    return when {
        days <= 0 -> "Next $time"
        days == 1L -> "Next $time tomorrow"
        else -> "Next $time on ${then.format(DateTimeFormatter.ofPattern("MMM d", locale))}"
    }
}

/** Each routine's place, active above paused, the list's own order within each. */
fun rankRoutines(list: List<Routine>): Map<String, Int> =
    list.sortedBy { it.paused }.mapIndexed { i, r -> r.id to i }.toMap()

/** [list] in [rank]'s order; one added since lands after the ranked ones, active before paused. */
fun orderRoutines(list: List<Routine>, rank: Map<String, Int>): List<Routine> =
    list.sortedBy { rank[it.id] ?: (rank.size + if (it.paused) 1 else 0) }
