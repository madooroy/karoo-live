package io.github.madooroy.karoolive

import android.content.Context
import android.content.SharedPreferences
import timber.log.Timber
import java.security.SecureRandom

/** All user settings plus a little runtime state, stored in SharedPreferences on the Karoo. */
class Settings(context: Context) {
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences("karoo_live", Context.MODE_PRIVATE)

    var enabled: Boolean
        get() = prefs.getBoolean("enabled", true)
        set(v) = prefs.edit().putBoolean("enabled", v).apply()

    var riderName: String
        get() = prefs.getString("riderName", "") ?: ""
        set(v) = prefs.edit().putString("riderName", v.trim()).apply()

    /** Whatever the user typed: a full URL, a host, or just the Firebase project id. */
    var databaseUrl: String
        get() = prefs.getString("databaseUrl", "") ?: ""
        set(v) = prefs.edit().putString("databaseUrl", v.trim()).apply()

    var apiKey: String
        get() = prefs.getString("apiKey", "") ?: ""
        set(v) = prefs.edit().putString("apiKey", v.trim()).apply()

    var email: String
        get() = prefs.getString("email", "") ?: ""
        set(v) = prefs.edit().putString("email", v.trim()).apply()

    var password: String
        get() = prefs.getString("password", "") ?: ""
        set(v) = prefs.edit().putString("password", v).apply()

    var intervalSeconds: Int
        get() = prefs.getInt("intervalSeconds", 15)
        set(v) = prefs.edit().putInt("intervalSeconds", v.coerceIn(5, 300)).apply()

    /** Optional KarooTracker (k2tracker.drakey.co.uk) id, only used to build a combined viewer link. */
    var k2tId: String
        get() = prefs.getString("k2tId", "") ?: ""
        set(v) = prefs.edit().putString("k2tId", v.trim().split("/").last()).apply()

    /** Random, unguessable id that forms the public part of the viewer link. */
    val shareId: String
        get() {
            val existing = prefs.getString("shareId", null)
            if (!existing.isNullOrBlank()) return existing
            val fresh = newShareId()
            prefs.edit().putString("shareId", fresh).apply()
            return fresh
        }

    /** Accepts an id chosen elsewhere (e.g. by the setup page) if it looks safe. */
    fun setShareId(id: String): Boolean {
        val clean = id.trim()
        if (!Regex("^[A-Za-z0-9_-]{6,64}$").matches(clean)) return false
        prefs.edit().putString("shareId", clean).apply()
        return true
    }

    fun regenerateShareId(): String {
        val fresh = newShareId()
        prefs.edit().putString("shareId", fresh).apply()
        return fresh
    }

    // ---- auth cache ----
    var refreshToken: String
        get() = prefs.getString("refreshToken", "") ?: ""
        set(v) = prefs.edit().putString("refreshToken", v).apply()

    var authEmail: String
        get() = prefs.getString("authEmail", "") ?: ""
        set(v) = prefs.edit().putString("authEmail", v).apply()

    // ---- ride state that must survive a service restart ----
    var activeRideStartedAt: Long
        get() = prefs.getLong("activeRideStartedAt", 0L)
        set(v) = prefs.edit().putLong("activeRideStartedAt", v).apply()

    var activeRideShareId: String
        get() = prefs.getString("activeRideShareId", "") ?: ""
        set(v) = prefs.edit().putString("activeRideShareId", v).apply()

    /** True once this share link has been tested or ridden with; imports then won't silently replace it. */
    var linkUsed: Boolean
        // Existing installs from before this flag: treat the link as used if the app ever did anything.
        get() = prefs.getBoolean("linkUsed", prefs.contains("shareId") && prefs.getLong("lastStatusAt", 0L) > 0L && !(prefs.getString("lastStatus", "") ?: "").startsWith("Not set up"))
        set(v) = prefs.edit().putBoolean("linkUsed", v).apply()

    /** Viewers can send short messages that pop up during a ride. */
    var messagesEnabled: Boolean
        get() = prefs.getBoolean("messagesEnabled", true)
        set(v) = prefs.edit().putBoolean("messagesEnabled", v).apply()

    /** Like Garmin: a message stays on screen until swiped up. Off = clears itself after 15 s. */
    var messagesStay: Boolean
        get() = prefs.getBoolean("messagesStay", true)
        set(v) = prefs.edit().putBoolean("messagesStay", v).apply()

    /** Server time of the newest message already picked up this ride. */
    var lastMessageTs: Long
        get() = prefs.getLong("lastMessageTs", 0L)
        set(v) = prefs.edit().putLong("lastMessageTs", v).apply()

    /** Messages shown this ride (capped). */
    var rideMessages: Int
        get() = prefs.getInt("rideMessages", 0)
        set(v) = prefs.edit().putInt("rideMessages", v).apply()

    /** This ride's messages, newest last, one per line: "<ms>\t<from>\t<text>". Shown in the app. */
    var rideMessageLog: String
        get() = prefs.getString("rideMessageLog", "") ?: ""
        set(v) = prefs.edit().putString("rideMessageLog", v).apply()

    fun addRideMessage(at: Long, from: String, text: String) {
        val clean = { s: String -> s.replace('\t', ' ').replace('\n', ' ').replace('\r', ' ') }
        rideMessageLog = (rideMessageLog.lines().filter { it.isNotBlank() } + "$at\t${clean(from)}\t${clean(text)}").takeLast(40).joinToString("\n")
    }

    /** Gear changes counted during the current ride. */
    var rideShifts: Int
        get() = prefs.getInt("rideShifts", 0)
        set(v) = prefs.edit().putInt("rideShifts", v).apply()

    /** Whether the Firebase node for the active ride has been created yet (PUT succeeded). */
    var rideNodeCreated: Boolean
        get() = prefs.getBoolean("rideNodeCreated", false)
        set(v) = prefs.edit().putBoolean("rideNodeCreated", v).apply()

    // ---- status shown on the settings screen ----
    var lastStatus: String
        get() = prefs.getString("lastStatus", "Not started yet") ?: ""
        set(v) = prefs.edit().putString("lastStatus", v).apply()

    var lastStatusAt: Long
        get() = prefs.getLong("lastStatusAt", 0L)
        set(v) = prefs.edit().putLong("lastStatusAt", v).apply()

    fun setStatus(message: String) {
        if (message != lastStatus && !message.startsWith("Live:") && !message.startsWith("Error")) Timber.i("Status: $message")
        lastStatus = message
        lastStatusAt = System.currentTimeMillis()
    }

    val isConfigured: Boolean
        get() = databaseHost.isNotBlank() && apiKey.isNotBlank() && email.isNotBlank() && password.isNotBlank()

    /** e.g. "my-project-default-rtdb.firebaseio.com" */
    val databaseHost: String
        get() = normalizeDatabaseHost(databaseUrl)

    /** Link friends open. Short `db` form when the database uses the default US host. */
    val viewerUrl: String
        get() {
            val host = databaseHost
            val db = if (host.endsWith(DEFAULT_SUFFIX)) host.removeSuffix(DEFAULT_SUFFIX) else host
            val sb = StringBuilder(VIEWER_BASE).append("?db=").append(db).append("&id=").append(shareId)
            if (k2tId.isNotBlank()) sb.append("&k2t=").append(k2tId)
            return sb.toString()
        }

    companion object {
        const val VIEWER_BASE = "https://mybikeride.live/"
        const val DEFAULT_SUFFIX = "-default-rtdb.firebaseio.com"
        private const val ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"

        fun newShareId(): String {
            val rnd = SecureRandom()
            return (1..10).map { ALPHABET[rnd.nextInt(ALPHABET.length)] }.joinToString("")
        }

        fun normalizeDatabaseHost(input: String): String {
            var s = input.trim().lowercase()
            if (s.isEmpty()) return ""
            s = s.removePrefix("https://").removePrefix("http://")
            s = s.substringBefore("/").substringBefore("?")
            // Bare project id ("my-project") or "my-project-default-rtdb"
            if (!s.contains(".")) {
                s = if (s.endsWith("-default-rtdb")) "$s.firebaseio.com" else "$s$DEFAULT_SUFFIX"
            }
            return s
        }
    }
}
