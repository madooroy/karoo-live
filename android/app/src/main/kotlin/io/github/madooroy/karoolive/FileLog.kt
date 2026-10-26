package io.github.madooroy.karoolive

import android.content.Context
import android.util.Log
import timber.log.Timber
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Writes the app's log to a daily file so problems on a ride can be looked at afterwards:
 *   /sdcard/Android/data/io.github.madooroy.karoolive/files/logs/karoo-live-YYYY-MM-DD.log
 * Copy it to a computer with:  adb pull /sdcard/Android/data/io.github.madooroy.karoolive/files/logs
 * The last lines are also shown on the settings screen. Files older than a week are deleted.
 */
class FileLog private constructor(private val dir: File) : Timber.Tree() {
    private val day = SimpleDateFormat("yyyy-MM-dd", Locale.US)
    private val time = SimpleDateFormat("HH:mm:ss.SSS", Locale.US)

    override fun log(priority: Int, tag: String?, message: String, t: Throwable?) {
        if (priority < Log.INFO) return
        val level = when (priority) { Log.WARN -> "W"; Log.ERROR, Log.ASSERT -> "E"; else -> "I" }
        val now = Date()
        val line = "${time.format(now)} $level $message" + (t?.let { " (${it.javaClass.simpleName}: ${it.message})" } ?: "") + "\n"
        synchronized(LOCK) {
            try {
                dir.mkdirs()
                File(dir, "karoo-live-${day.format(now)}.log").appendText(line)
            } catch (e: Exception) {
                // never let logging break the app
            }
        }
    }

    companion object {
        private val LOCK = Any()
        @Volatile private var installed = false

        fun logDir(context: Context): File =
            File(context.getExternalFilesDir(null) ?: context.filesDir, "logs")

        fun install(context: Context) {
            if (installed) return
            synchronized(LOCK) {
                if (installed) return
                val dir = logDir(context.applicationContext)
                try {
                    val cutoff = System.currentTimeMillis() - 7L * 24 * 3600 * 1000
                    dir.listFiles()?.filter { it.lastModified() < cutoff }?.forEach { it.delete() }
                } catch (e: Exception) { }
                Timber.plant(Timber.DebugTree())
                Timber.plant(FileLog(dir))
                installed = true
            }
        }

        /** Last [lines] lines across the newest log files, oldest first. */
        fun tail(context: Context, lines: Int = 60): List<String> = try {
            val files = logDir(context).listFiles()?.filter { it.name.endsWith(".log") }?.sortedBy { it.name } ?: emptyList()
            val out = ArrayDeque<String>()
            for (f in files.takeLast(2)) {
                f.forEachLine { out.addLast(it); if (out.size > lines) out.removeFirst() }
            }
            out.toList()
        } catch (e: Exception) {
            emptyList()
        }
    }
}
