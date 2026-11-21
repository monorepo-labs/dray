package com.yogesh.dray

import com.yogesh.dray.ui.Look
import com.yogesh.dray.ui.OrbConfig
import com.yogesh.dray.ui.OrbEngine
import com.yogesh.dray.ui.OrbState
import com.yogesh.dray.ui.OrbVariant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class OrbTest {
    @Test
    fun aVariantItsStateLacksFallsBackToDefault() {
        assertEquals(Look.WorkingGyro, Look.of(OrbState.Working, OrbVariant.Gyro))
        assertEquals(Look.Working, Look.of(OrbState.Working, OrbVariant.Spiral))
        assertEquals(Look.SearchingLighthouse, Look.of(OrbState.Searching, OrbVariant.Lighthouse))
    }

    @Test
    fun everyLookDrawsFiniteDotsInsideItsBox() {
        for (look in Look.entries) {
            val engine = OrbEngine(OrbConfig(look, 20.0))
            for (t in listOf(0.0, 850.0, 4321.0, 13000.0)) {
                var dots = 0
                engine.draw(t) { x, y, r, a ->
                    dots++
                    assertTrue("$look x", x.isFinite() && x > -10 && x < 30)
                    assertTrue("$look y", y.isFinite() && y > -10 && y < 30)
                    assertTrue("$look r", r.isFinite() && r >= 0)
                    assertTrue("$look a=$a", a.isFinite() && a >= -1e-9 && a <= 1 + 1e-9)
                }
                assertTrue("$look draws", dots >= 8)
            }
        }
    }

    @Test
    fun workingAtTwentyHasTheTunedDotCount() {
        var dots = 0
        OrbEngine(OrbConfig(Look.Working, 20.0)).draw(0.0) { _, _, _, _ -> dots++ }
        // size × 4 dots: the package's density for every look but Background, Using and Type.
        assertEquals(80, dots)
    }
}
