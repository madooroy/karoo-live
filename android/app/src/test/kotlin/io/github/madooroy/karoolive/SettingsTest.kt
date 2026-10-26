package io.github.madooroy.karoolive

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SettingsTest {
    @Test
    fun normalizesDatabaseInputs() {
        val h = "my-proj-default-rtdb.firebaseio.com"
        assertEquals(h, Settings.normalizeDatabaseHost("my-proj"))
        assertEquals(h, Settings.normalizeDatabaseHost("my-proj-default-rtdb"))
        assertEquals(h, Settings.normalizeDatabaseHost("https://my-proj-default-rtdb.firebaseio.com/"))
        assertEquals(h, Settings.normalizeDatabaseHost("  HTTPS://My-Proj-default-rtdb.firebaseio.com/live?x=1 "))
        assertEquals(
            "my-proj-default-rtdb.europe-west1.firebasedatabase.app",
            Settings.normalizeDatabaseHost("https://my-proj-default-rtdb.europe-west1.firebasedatabase.app"),
        )
        assertEquals("", Settings.normalizeDatabaseHost(""))
    }

    @Test
    fun shareIdsAreRandomAndUrlSafe() {
        val ids = (1..200).map { Settings.newShareId() }.toSet()
        assertEquals(200, ids.size)
        assertTrue(ids.all { Regex("^[a-z0-9]{10}$").matches(it) })
    }
}
