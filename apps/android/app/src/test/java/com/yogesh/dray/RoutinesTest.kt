package com.yogesh.dray

import com.yogesh.dray.model.nextRunLabel
import com.yogesh.dray.model.scheduleLabel
import com.yogesh.dray.wire.Routine
import com.yogesh.dray.wire.RoutineSchedule
import com.yogesh.dray.wire.decodeList
import com.yogesh.dray.wire.wireJson
import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.ZoneOffset
import java.time.ZonedDateTime
import java.util.Locale

class RoutinesTest {
    private fun r(schedule: RoutineSchedule = RoutineSchedule(), paused: Boolean = false, nextRun: String? = null) =
        Routine(id = "r", name = "Check", schedule = schedule, paused = paused, nextRun = nextRun)

    @Test fun schedulesReadAsTheDesktopSaysThem() {
        assertEquals("Every 30m", scheduleLabel(r(RoutineSchedule(everyMinutes = 30))))
        assertEquals("Every 2h", scheduleLabel(r(RoutineSchedule(everyMinutes = 120))))
        assertEquals("Every 1d", scheduleLabel(r(RoutineSchedule(everyMinutes = 1440))))
        assertEquals("Daily at 09:00", scheduleLabel(r(RoutineSchedule(at = "09:00"))))
        assertEquals("Daily at 09:00", scheduleLabel(r(RoutineSchedule(at = "09:00", days = listOf(6, 5, 4, 3, 2, 1, 0)))))
        assertEquals("Weekdays at 09:00", scheduleLabel(r(RoutineSchedule(at = "09:00", days = listOf(4, 0, 1, 2, 3, 3)))))
        assertEquals("Weekends at 10:30", scheduleLabel(r(RoutineSchedule(at = "10:30", days = listOf(5, 6)))))
        assertEquals("Mon, Wed at ?", scheduleLabel(r(RoutineSchedule(days = listOf(2, 0)))))
    }

    @Test fun nextRunCountsDownThenNamesTheDay() {
        val zone = ZoneOffset.UTC
        val now = ZonedDateTime.of(2026, 11, 28, 22, 0, 0, 0, zone)
        val ms = now.toInstant().toEpochMilli()
        fun at(t: ZonedDateTime) = nextRunLabel(r(nextRun = t.toInstant().toString()), ms, zone, Locale.US)
        assertEquals("Paused", nextRunLabel(r(paused = true, nextRun = now.toString()), ms, zone, Locale.US))
        assertEquals("Not scheduled", nextRunLabel(r(), ms, zone, Locale.US))
        assertEquals("Due now", at(now.minusMinutes(3)))
        assertEquals("Next in 34m", at(now.plusMinutes(34)))
        // Newer JDKs put a narrow no-break space before AM/PM.
        assertEquals("Next 11:30 PM", at(now.plusMinutes(90)).replace(' ', ' '))
        // Three hours on is past midnight: a calendar day, not 24 hours.
        assertEquals("Next 1:00 AM tomorrow", at(now.plusHours(3)).replace(' ', ' '))
        assertEquals("Next 9:00 AM on Dec 1", at(now.plusDays(3).withHour(9)).replace(' ', ' '))
    }

    @Test fun aBadEntryCostsItselfNotTheList() {
        val list = decodeList<Routine>(
            wireJson.parseToJsonElement(
                """[{"id":"a","botId":"b","name":"One","prompt":"p","schedule":{"everyMinutes":60,"days":null},"paused":null,"nextRun":null,"lastResult":{"outcome":"silent"}},
                   {"name":"no id"},
                   {"id":"c","schedule":{"at":"09:00","days":[0,1]}}]""",
            ),
        )
        assertEquals(listOf("a", "c"), list.map { it.id })
        assertEquals(emptyList<Int>(), list[0].schedule.days)
        assertEquals(false, list[0].paused)
        assertEquals("Mon, Tue at 09:00", scheduleLabel(list[1]))
    }
}
