package io.github.madooroy.karoolive

import io.hammerhead.karooext.KarooSystemService
import io.hammerhead.karooext.extension.KarooExtension
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import timber.log.Timber

/**
 * Started (bound) by the Karoo system when the device boots. Runs the [Tracker] for as long
 * as the Karoo keeps the extension alive; the tracker only uploads while a ride is recording.
 */
class LiveExtension : KarooExtension("karoolive", BuildConfig.VERSION_NAME) {
    private lateinit var karooSystem: KarooSystemService
    private var tracker: Tracker? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onCreate() {
        super.onCreate()
        FileLog.install(applicationContext)
        Timber.i("Karoo Live ${BuildConfig.VERSION_NAME} started (Android ${android.os.Build.VERSION.RELEASE}, ${android.os.Build.MODEL})")
        karooSystem = KarooSystemService(applicationContext)
        val t = Tracker(karooSystem, Settings(applicationContext), scope)
        tracker = t
        karooSystem.connect { connected ->
            Timber.i("Karoo Live: Karoo system connected=$connected")
        }
        t.start()
    }

    override fun onDestroy() {
        tracker?.stop()
        scope.cancel()
        karooSystem.disconnect()
        super.onDestroy()
    }
}
