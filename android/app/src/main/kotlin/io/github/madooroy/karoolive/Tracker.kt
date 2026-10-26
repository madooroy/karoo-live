package io.github.madooroy.karoolive

import io.hammerhead.karooext.KarooSystemService
import io.hammerhead.karooext.models.DataType
import io.hammerhead.karooext.models.OnNavigationState
import io.hammerhead.karooext.models.OnStreamState
import io.hammerhead.karooext.models.RideState
import io.hammerhead.karooext.models.StreamState
import io.hammerhead.karooext.models.SystemNotification
import io.hammerhead.karooext.models.UserProfile
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import timber.log.Timber
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import kotlin.math.roundToLong

/**
 * Watches the ride and pushes a snapshot to Firebase every few seconds while recording.
 *
 * Database layout (all values SI: m, m/s, W, rpm, bpm, ms):
 * ```
 * /owner                      uid of the account allowed to write
 * /live/<shareId>/name        rider name
 * /live/<shareId>/units       "imperial" | "metric" (display preference)
 * /live/<shareId>/state       "recording" | "paused" | "idle"
 * /live/<shareId>/startedAt   ms, /updatedAt server ms, /endedAt server ms
 * /live/<shareId>/cur         latest values {lat,lng,brg,alt,spd,cad,pwr,hr,dist,el (total ms),rt (recording ms),gain,avgSpd,avgPwr,np,bat,grade,temp,toGo,climbLeft}
 * /live/<shareId>/route       {poly (precision 5), name, dist} while navigating
 * /live/<shareId>/track/p<ms> {t,lat,lng,alt,spd,cad,pwr,hr,d} one point per update
 * ```
 */
class Tracker(
    private val karooSystem: KarooSystemService,
    private val settings: Settings,
    private val scope: CoroutineScope,
) {
    private val http = Http(karooSystem)
    private val firebase = FirebaseClient(settings, http)

    private val latest = ConcurrentHashMap<String, Map<String, Double>>()
    @Volatile private var rideState: RideState? = null // unknown until the Karoo system reports it
    private var lastSeenActive: Boolean? = null
    private var startupWaits = 0
    @Volatile private var units = "metric"
    @Volatile private var route: JsonElement = JsonNull
    @Volatile private var routeDirty = false
    private var ownerCheckedFor = ""
    private val pendingTrack = LinkedHashMap<String, JsonObject>()
    private val wake = Channel<Unit>(Channel.CONFLATED)
    private var notifiedErrorThisRide = false
    private val consumerIds = mutableListOf<String>()

    fun start() {
        STREAMED_TYPES.forEach { typeId ->
            consumerIds += karooSystem.addConsumer(OnStreamState.StartStreaming(typeId)) { event: OnStreamState ->
                when (val state = event.state) {
                    is StreamState.Streaming -> latest[typeId] = state.dataPoint.values
                    else -> latest.remove(typeId)
                }
            }
        }
        consumerIds += karooSystem.addConsumer<RideState> { state ->
            val changed = rideState == null || state::class != rideState!!::class
            rideState = state
            if (changed) wake.trySend(Unit)
        }
        consumerIds += karooSystem.addConsumer<UserProfile> { profile ->
            units = if (profile.preferredUnit.distance == UserProfile.PreferredUnit.UnitType.IMPERIAL) "imperial" else "metric"
        }
        consumerIds += karooSystem.addConsumer<OnNavigationState> { event ->
            val newRoute: JsonElement = when (val nav = event.state) {
                is OnNavigationState.NavigationState.NavigatingRoute -> buildJsonObject {
                    put("poly", nav.routePolyline)
                    put("name", nav.name)
                    put("dist", nav.routeDistance)
                }
                is OnNavigationState.NavigationState.NavigatingToDestination -> buildJsonObject {
                    put("poly", nav.polyline)
                    put("name", nav.destination.name ?: "Destination")
                }
                else -> JsonNull
            }
            if (newRoute != route) {
                route = newRoute
                routeDirty = true
            }
        }

        scope.launch {
            while (true) {
                try {
                    tick()
                } catch (e: Exception) {
                    Timber.w(e, "tick failed")
                }
                val waitMs = settings.intervalSeconds * 1000L
                withTimeoutOrNull(waitMs) { wake.receive() }
            }
        }
    }

    fun stop() {
        consumerIds.forEach { karooSystem.removeConsumer(it) }
        consumerIds.clear()
    }

    private suspend fun tick() {
        val state = rideState
        if (state == null) {
            settings.setStatus("Waiting for the Karoo system")
            return
        }
        if (!settings.isConfigured) {
            settings.setStatus("Not set up yet: open Karoo Live settings")
            return
        }
        val active = state is RideState.Recording || state is RideState.Paused
        val wasActive = lastSeenActive
        lastSeenActive = active

        if (!active) {
            // Ride ended (or we restarted after one): mark it finished, even if sharing is switched off.
            if (settings.activeRideStartedAt != 0L && endRide()) {
                settings.setStatus("Ride finished, tracking stopped")
            } else if (!settings.enabled) {
                settings.setStatus("Sharing is switched off")
            }
            return
        }
        if (!settings.enabled) {
            settings.setStatus("Sharing is switched off")
            return
        }

        if (ownerCheckedFor != ownerKey()) {
            try {
                firebase.ensureOwner()
                ownerCheckedFor = ownerKey()
            } catch (e: Exception) {
                fail(e)
                return
            }
        }

        val now = System.currentTimeMillis()
        val shareId = settings.shareId
        var newRide = settings.activeRideStartedAt == 0L
        if (!newRide) {
            when {
                // The share link was changed: close the old page, start fresh on the new one.
                settings.activeRideShareId != shareId -> newRide = true
                // This service saw the Karoo go idle and start again, so the earlier end update never got out.
                wasActive == false -> newRide = true
                // Service just started during a ride: is it the ride we were tracking, or a new one?
                wasActive == null -> {
                    val totalMs = value(DataType.Type.RIDE_TIME, DataType.Field.RIDE_TIME)
                    if (totalMs == null && startupWaits++ < 3) return // give the ride clock a moment to arrive
                    if (totalMs != null && now - settings.activeRideStartedAt > totalMs + 10 * 60_000) newRide = true
                }
            }
        }
        if (newRide) {
            if (settings.activeRideStartedAt != 0L) endRide() // best effort for the previous ride
            beginRide(shareId, now)
        }

        val cur = currentValues()
        if (state is RideState.Recording && cur.containsKey("lat")) {
            pendingTrack["p$now"] = trackPoint(now, cur)
            while (pendingTrack.size > MAX_PENDING) pendingTrack.remove(pendingTrack.keys.first())
        }

        if (!settings.rideNodeCreated) {
            val node = buildJsonObject {
                put("name", riderName())
                put("units", units)
                put("state", "recording")
                put("startedAt", settings.activeRideStartedAt)
                put("updatedAt", FirebaseClient.SERVER_TIME)
                put("route", route)
            }
            try {
                firebase.put("live/$shareId", node) // replaces the previous ride on this link, clearing its track
                settings.rideNodeCreated = true
                routeDirty = false
            } catch (e: Exception) {
                fail(e) // points stay queued until the connection is back
                return
            }
        }

        val sentPoints = pendingTrack.keys.toList()
        val includeRoute = routeDirty
        val ok = send(shareId) {
            put("state", if (state is RideState.Paused) "paused" else "recording")
            put("updatedAt", FirebaseClient.SERVER_TIME)
            put("name", riderName())
            put("units", units)
            put("cur", cur)
            if (includeRoute) put("route", route)
            sentPoints.forEach { key -> pendingTrack[key]?.let { put("track/$key", it) } }
        }
        if (ok != null) {
            sentPoints.forEach { pendingTrack.remove(it) }
            if (includeRoute) routeDirty = false
            settings.setStatus("Live: last update sent ${TIME.format(Date())}")
        }
    }

    private fun beginRide(shareId: String, now: Long) {
        pendingTrack.clear()
        notifiedErrorThisRide = false
        routeDirty = false
        settings.activeRideStartedAt = now
        settings.activeRideShareId = shareId
        settings.rideNodeCreated = false
    }

    /** Marks the tracked ride finished (sending any queued points). Returns true once it's done. */
    private suspend fun endRide(): Boolean {
        val target = settings.activeRideShareId.ifBlank { settings.shareId }
        if (settings.rideNodeCreated) {
            val sentPoints = pendingTrack.keys.toList()
            send(target) {
                put("state", "idle")
                put("updatedAt", FirebaseClient.SERVER_TIME)
                put("endedAt", FirebaseClient.SERVER_TIME)
                sentPoints.forEach { key -> pendingTrack[key]?.let { put("track/$key", it) } }
            } ?: return false
        }
        pendingTrack.clear()
        settings.activeRideStartedAt = 0L
        settings.activeRideShareId = ""
        settings.rideNodeCreated = false
        return true
    }

    private suspend fun send(shareId: String, build: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit): Unit? {
        return try {
            firebase.patch("live/$shareId", buildJsonObject(build))
            Unit
        } catch (e: Exception) {
            fail(e)
            null
        }
    }

    private fun fail(e: Exception) {
        val msg = e.message ?: e.javaClass.simpleName
        Timber.w("Karoo Live: $msg")
        settings.setStatus("Error ${TIME.format(Date())}: $msg")
        val isConfigProblem = msg.contains("Sign-in") || msg.contains("permission", true) || msg.contains("owned by")
        if (isConfigProblem && !notifiedErrorThisRide) {
            notifiedErrorThisRide = true
            karooSystem.dispatch(
                SystemNotification(
                    id = "karoo-live-error",
                    message = "Karoo Live can't upload",
                    subText = msg.take(80),
                    action = "Settings",
                    actionIntent = "io.github.madooroy.karoolive.SETTINGS",
                ),
            )
        }
    }

    private fun currentValues(): JsonObject = buildJsonObject {
        latest[DataType.Type.LOCATION]?.let { loc ->
            val lat = loc[DataType.Field.LOC_LATITUDE]
            val lng = loc[DataType.Field.LOC_LONGITUDE]
            if (lat != null && lng != null && !(lat == 0.0 && lng == 0.0)) {
                put("lat", round(lat, 6))
                put("lng", round(lng, 6))
                loc[DataType.Field.LOC_BEARING]?.let { put("brg", round(it, 0)) }
                loc[DataType.Field.LOC_ACCURACY]?.let { put("acc", round(it, 0)) }
            }
        }
        value(DataType.Type.PRESSURE_ELEVATION_CORRECTION, DataType.Field.PRESSURE_ELEVATION)?.let { put("alt", round(it, 1)) }
        value(DataType.Type.SMOOTHED_3S_AVERAGE_SPEED, DataType.Field.SMOOTHED_3S_AVERAGE_SPEED)?.let { put("spd", round(it, 2)) }
        value(DataType.Type.SMOOTHED_3S_AVERAGE_CADENCE, DataType.Field.SMOOTHED_3S_AVERAGE_CADENCE)?.let { put("cad", round(it, 0)) }
        value(DataType.Type.SMOOTHED_3S_AVERAGE_POWER, DataType.Field.SMOOTHED_3S_AVERAGE_POWER)?.let { put("pwr", round(it, 0)) }
        value(DataType.Type.HEART_RATE, DataType.Field.HEART_RATE)?.let { put("hr", round(it, 0)) }
        value(DataType.Type.DISTANCE, DataType.Field.DISTANCE)?.let { put("dist", round(it, 0)) }
        // Note the SDK naming: RIDE_TIME is total time incl. pauses, ELAPSED_TIME is time spent recording.
        value(DataType.Type.RIDE_TIME, DataType.Field.RIDE_TIME)?.let { put("el", it.roundToLong()) }
        value(DataType.Type.ELAPSED_TIME, DataType.Field.ELAPSED_TIME)?.let { put("rt", it.roundToLong()) }
        value(DataType.Type.ELEVATION_GAIN, DataType.Field.ELEVATION_GAIN)?.let { put("gain", round(it, 0)) }
        value(DataType.Type.AVERAGE_SPEED, DataType.Field.AVERAGE_SPEED)?.let { put("avgSpd", round(it, 2)) }
        value(DataType.Type.AVERAGE_POWER, DataType.Field.AVERAGE_POWER)?.let { put("avgPwr", round(it, 0)) }
        value(DataType.Type.NORMALIZED_POWER, DataType.Field.NORMALIZED_POWER)?.let { put("np", round(it, 0)) }
        value(DataType.Type.BATTERY_PERCENT, DataType.Field.BATTERY_PERCENT)?.let { put("bat", round(it, 0)) }
        value(DataType.Type.ELEVATION_GRADE, DataType.Field.ELEVATION_GRADE)?.let { put("grade", round(it, 1)) }
        value(DataType.Type.TEMPERATURE, DataType.Field.TEMPERATURE)?.let { put("temp", round(it, 1)) }
        value(DataType.Type.DISTANCE_TO_DESTINATION, DataType.Field.DISTANCE_TO_DESTINATION)?.let { put("toGo", round(it, 0)) }
        value(DataType.Type.ELEVATION_REMAINING, DataType.Field.ASCENT_REMAINING)?.let { put("climbLeft", round(it, 0)) }
    }

    private fun trackPoint(now: Long, cur: JsonObject): JsonObject = buildJsonObject {
        put("t", now)
        listOf("lat", "lng", "alt", "spd", "cad", "pwr", "hr").forEach { k -> cur[k]?.let { put(k, it) } }
        cur["dist"]?.let { put("d", it) }
    }

    /** Reads a field, falling back to the only value when the field id differs. */
    private fun value(typeId: String, fieldId: String): Double? {
        val values = latest[typeId] ?: return null
        val v = values[fieldId] ?: values.values.singleOrNull() ?: return null
        return if (v.isNaN() || v.isInfinite()) null else v
    }

    private fun riderName() = settings.riderName.ifBlank { "Karoo rider" }

    private fun ownerKey() = "${settings.databaseHost}|${settings.email}"

    private fun round(v: Double, decimals: Int): JsonPrimitive {
        if (decimals == 0) return JsonPrimitive(v.roundToLong())
        var f = 1.0
        repeat(decimals) { f *= 10 }
        return JsonPrimitive((v * f).roundToLong() / f)
    }

    companion object {
        private const val MAX_PENDING = 400
        private val TIME = SimpleDateFormat("HH:mm:ss", Locale.US)

        val STREAMED_TYPES = listOf(
            DataType.Type.LOCATION,
            DataType.Type.PRESSURE_ELEVATION_CORRECTION,
            DataType.Type.SMOOTHED_3S_AVERAGE_SPEED,
            DataType.Type.SMOOTHED_3S_AVERAGE_CADENCE,
            DataType.Type.SMOOTHED_3S_AVERAGE_POWER,
            DataType.Type.HEART_RATE,
            DataType.Type.DISTANCE,
            DataType.Type.ELAPSED_TIME,
            DataType.Type.RIDE_TIME,
            DataType.Type.ELEVATION_GAIN,
            DataType.Type.AVERAGE_SPEED,
            DataType.Type.AVERAGE_POWER,
            DataType.Type.NORMALIZED_POWER,
            DataType.Type.BATTERY_PERCENT,
            DataType.Type.ELEVATION_GRADE,
            DataType.Type.TEMPERATURE,
            DataType.Type.DISTANCE_TO_DESTINATION,
            DataType.Type.ELEVATION_REMAINING,
        )
    }
}
