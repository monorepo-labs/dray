package com.yogesh.dray

import com.yogesh.dray.ui.OrbKind
import com.yogesh.dray.ui.OrbLook
import com.yogesh.dray.ui.look
import com.yogesharc.thinkingorbs.OrbState
import com.yogesharc.thinkingorbs.OrbVariant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class OrbTest {
    @Test
    fun everyKindDrawsTheOrbIosAndTheDesktopDraw() {
        assertEquals(OrbLook(OrbState.Working), OrbKind.Working.look)
        assertEquals(OrbLook(OrbState.Working, OrbVariant.Gyro), OrbKind.Delegating.look)
        assertEquals(OrbLook(OrbState.Background, OrbVariant.Spiral), OrbKind.Background.look)
        assertEquals(OrbLook(OrbState.Searching, OrbVariant.Lighthouse, 3.0), OrbKind.Reconnecting.look)
        assertEquals(OrbLook(OrbState.Searching), OrbKind.Loading.look)
    }

    @Test
    fun noKindAsksForAVariantItsStateLacks() {
        // The library quietly draws Default for one its state doesn't have, so a typo here would go unseen.
        for (kind in OrbKind.entries) {
            val look = kind.look
            assertTrue("$kind", look.variant in look.state.variants)
        }
    }
}
