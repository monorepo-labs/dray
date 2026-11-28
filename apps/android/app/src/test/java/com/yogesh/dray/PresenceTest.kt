package com.yogesh.dray

import com.yogesh.dray.model.SessionKey
import com.yogesh.dray.push.RENEW_MS
import com.yogesh.dray.push.Said
import com.yogesh.dray.push.due
import org.junit.Assert.assertEquals
import org.junit.Test

class PresenceTest {
    private val a = SessionKey("A", "chat")
    private val none = emptyMap<String, List<String>>()

    @Test fun aChatOnScreenIsSaidToItsServerAlone() {
        assertEquals(mapOf("A" to listOf("chat")), due(a, true, emptyMap(), 0))
    }

    @Test fun nothingIsSaidWhileNothingChangedOrIsHeld() {
        assertEquals(none, due(null, true, emptyMap(), 0))
        assertEquals(none, due(a, false, emptyMap(), 0))
        assertEquals(none, due(a, true, mapOf("A" to Said(listOf("chat"), 0)), RENEW_MS - 1))
    }

    @Test fun aLeaseIsRenewedOnceDue() {
        assertEquals(mapOf("A" to listOf("chat")), due(a, true, mapOf("A" to Said(listOf("chat"), 0)), RENEW_MS))
    }

    @Test fun movingOrLeavingTellsTheOldServerNothing() {
        val said = mapOf("A" to Said(listOf("chat"), 0))
        assertEquals(mapOf("A" to emptyList(), "B" to listOf("other")), due(SessionKey("B", "other"), true, said, 1))
        assertEquals(mapOf("A" to emptyList<String>()), due(a, false, said, 1))
        assertEquals(mapOf("A" to emptyList<String>()), due(null, true, said, 1))
    }
}
