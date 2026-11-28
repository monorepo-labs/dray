package com.yogesh.dray

import com.yogesh.dray.net.connectionFailure
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NetworkTest {
    @Test fun connectionFailuresAreToldApart() {
        assertTrue(connectionFailure("Not connected"))
        assertTrue(connectionFailure("Couldn't start #12: Not connected"))
        assertTrue(connectionFailure("Reconnecting"))
        assertTrue(connectionFailure("Unable to resolve host \"drayhq.com\": No address associated with hostname"))
        assertTrue(connectionFailure("Failed to connect to /10.0.2.2:7399"))
        assertTrue(connectionFailure("The server took too long to answer interrupt_session"))
    }

    @Test fun anythingElseStillShows() {
        assertFalse(connectionFailure("Session not found"))
        assertFalse(connectionFailure("Wait for this turn to finish before switching to Codex."))
        assertFalse(connectionFailure("wrong token"))
    }
}
