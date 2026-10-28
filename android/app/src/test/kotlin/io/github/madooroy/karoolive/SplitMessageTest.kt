package io.github.madooroy.karoolive

import org.junit.Assert.assertEquals
import org.junit.Test

/** Same cases as the viewer's preview (tests/viewer_test.py), so the page shows what the Karoo does. */
class SplitMessageTest {
    @Test fun shortStaysWhole() = assertEquals(listOf("Woot woot"), Tracker.splitMessage("Woot woot"))

    @Test fun exactly35Fits() {
        val s = "Test. Test. 1, 2, 3. Test. Test. ab" // 35
        assertEquals(listOf(s), Tracker.splitMessage(s))
    }

    @Test fun splitsAtWords() = assertEquals(
        listOf("Faster!!! Think SPEED and keep the", "Cadence up."),
        Tracker.splitMessage("Faster!!! Think SPEED and keep the Cadence up."),
    )

    @Test fun longWordIsCut() = assertEquals(
        listOf("a", "x".repeat(35), "xxxxx b"),
        Tracker.splitMessage("a " + "x".repeat(40) + " b"),
    )

    @Test fun extraSpacesIgnored() = assertEquals(listOf("hi there"), Tracker.splitMessage("  hi   there \n"))
}
