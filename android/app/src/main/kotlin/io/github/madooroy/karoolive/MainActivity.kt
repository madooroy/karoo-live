package io.github.madooroy.karoolive

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.text.InputType
import android.util.Base64
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import io.hammerhead.karooext.KarooSystemService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import java.text.DateFormat
import java.util.Date

/**
 * Settings screen, built in code to keep the app tiny. Can also be configured from a computer:
 *
 * adb shell am start -n io.github.madooroy.karoolive/.MainActivity --es config <code from setup page>
 *
 * (Individual extras db, key, email, password, name, interval, k2t, id also work.)
 */
class MainActivity : Activity() {
    private lateinit var settings: Settings
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var statusJob: Job? = null

    private lateinit var status: TextView
    private lateinit var enabledSwitch: Switch
    private lateinit var name: EditText
    private lateinit var db: EditText
    private lateinit var key: EditText
    private lateinit var email: EditText
    private lateinit var password: EditText
    private lateinit var interval: EditText
    private lateinit var k2t: EditText
    private lateinit var linkText: TextView
    private lateinit var qr: ImageView
    private lateinit var logView: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        settings = Settings(this)
        FileLog.install(applicationContext)
        setContentView(buildUi())
        importFromIntent(intent)
        loadFields()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        importFromIntent(intent)
        loadFields()
    }

    override fun onResume() {
        super.onResume()
        statusJob = scope.launch {
            while (isActive) {
                val at = settings.lastStatusAt
                val time = if (at > 0) DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(at)) + "  " else ""
                status.text = time + settings.lastStatus
                logView.text = FileLog.tail(this@MainActivity, 40).joinToString("\n").ifBlank { "Nothing logged yet." }
                delay(2000)
            }
        }
    }

    override fun onPause() {
        statusJob?.cancel()
        super.onPause()
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private fun importFromIntent(intent: Intent?) {
        val extras = intent?.extras ?: return
        // "config" is a base64url JSON blob made by the setup page (survives any shell's quoting).
        val values = mutableMapOf<String, String>()
        extras.getString("config")?.let { token ->
            try {
                val text = String(Base64.decode(token.trim(), Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING), Charsets.UTF_8)
                Json.parseToJsonElement(text).jsonObject.forEach { (k, v) ->
                    (v as? JsonPrimitive)?.contentOrNull?.let { values[k] = it }
                }
            } catch (e: Exception) {
                toast("Couldn't read the setup code: ${e.message}")
            }
        }
        listOf("db", "key", "email", "password", "name", "k2t", "interval", "id").forEach { k ->
            extras.getString(k)?.let { values[k] = it }
        }
        var changed = false
        values["db"]?.let { settings.databaseUrl = it; changed = true }
        values["key"]?.let { settings.apiKey = it; changed = true }
        values["email"]?.let { settings.email = it; changed = true }
        values["password"]?.let { settings.password = it; changed = true }
        values["name"]?.let { settings.riderName = it; changed = true }
        values["k2t"]?.let { settings.k2tId = it; changed = true }
        values["interval"]?.toIntOrNull()?.let { settings.intervalSeconds = it; changed = true }
        values["id"]?.let { if (settings.setShareId(it)) { settings.activeRideShareId = ""; changed = true } }
        if (changed) {
            settings.refreshToken = ""
            Toast.makeText(this, "Settings imported", Toast.LENGTH_SHORT).show()
        }
    }

    private fun loadFields() {
        enabledSwitch.isChecked = settings.enabled
        name.setText(settings.riderName)
        db.setText(settings.databaseUrl)
        key.setText(settings.apiKey)
        email.setText(settings.email)
        password.setText(settings.password)
        interval.setText(settings.intervalSeconds.toString())
        k2t.setText(settings.k2tId)
        if (settings.isConfigured) showLink() else hideLink()
    }

    private fun save() {
        val oldAuth = settings.email + settings.password + settings.apiKey + settings.databaseHost
        settings.enabled = enabledSwitch.isChecked
        settings.riderName = name.text.toString()
        settings.databaseUrl = db.text.toString()
        settings.apiKey = key.text.toString()
        settings.email = email.text.toString()
        settings.password = password.text.toString()
        settings.intervalSeconds = interval.text.toString().toIntOrNull() ?: 15
        settings.k2tId = k2t.text.toString()
        if (oldAuth != settings.email + settings.password + settings.apiKey + settings.databaseHost) {
            settings.refreshToken = ""
        }
        interval.setText(settings.intervalSeconds.toString())
        if (settings.isConfigured) showLink() else hideLink()
    }

    private fun test() {
        save()
        if (!settings.isConfigured) {
            toast("Fill in database, API key, email and password first")
            return
        }
        status.text = "Testing…"
        scope.launch {
            val karoo = KarooSystemService(applicationContext)
            try {
                karoo.connect()
                repeat(30) { if (!karoo.connected) delay(100) }
                val fb = FirebaseClient(settings, Http(karoo))
                fb.resetAuth()
                fb.ensureOwner()
                fb.patch(
                    "live/${settings.shareId}",
                    buildJsonObject {
                        put("name", settings.riderName.ifBlank { "Karoo rider" })
                        put("lastTest", FirebaseClient.SERVER_TIME)
                    },
                )
                settings.setStatus("Connection test OK")
                toast("Connected! Open the share link to check.")
            } catch (e: Exception) {
                settings.setStatus("Test failed: ${e.message}")
                toast("Test failed: ${e.message}")
            } finally {
                try { karoo.disconnect() } catch (e: Exception) { }
            }
        }
    }

    private fun showLink() {
        val url = settings.viewerUrl
        linkText.text = url
        linkText.visibility = View.VISIBLE
        qr.setImageBitmap(qrBitmap(url, 520))
        qr.visibility = View.VISIBLE
    }

    private fun hideLink() {
        linkText.visibility = View.GONE
        qr.visibility = View.GONE
    }

    private fun qrBitmap(text: String, size: Int): Bitmap {
        val matrix = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, size, size, mapOf(EncodeHintType.MARGIN to 1))
        val pixels = IntArray(size * size)
        for (y in 0 until size) for (x in 0 until size) {
            pixels[y * size + x] = if (matrix.get(x, y)) Color.BLACK else Color.WHITE
        }
        return Bitmap.createBitmap(pixels, size, size, Bitmap.Config.RGB_565)
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_LONG).show()

    // ---------------- UI ----------------

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun buildUi(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(14), dp(12), dp(14), dp(24))
        }
        root.addView(TextView(this).apply {
            text = "Karoo Live"
            textSize = 24f
            setTypeface(typeface, Typeface.BOLD)
        })
        root.addView(TextView(this).apply {
            text = "Shares your ride (map, speed, power, cadence, heart rate) on a web page, using your own Firebase database."
            textSize = 13f
            alpha = 0.75f
            setPadding(0, dp(2), 0, dp(10))
        })
        status = TextView(this).apply {
            textSize = 14f
            setPadding(dp(10), dp(8), dp(10), dp(8))
            setBackgroundColor(Color.argb(40, 128, 128, 128))
        }
        root.addView(status, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))

        enabledSwitch = Switch(this).apply {
            text = "Share live during rides"
            textSize = 16f
            setPadding(0, dp(12), 0, dp(4))
            setOnCheckedChangeListener { _, checked -> settings.enabled = checked }
        }
        root.addView(enabledSwitch, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))

        name = field(root, "Your name (shown to viewers)", InputType.TYPE_TEXT_FLAG_CAP_WORDS)
        db = field(root, "Firebase database URL or project id", InputType.TYPE_TEXT_VARIATION_URI)
        key = field(root, "Firebase Web API key", InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS)
        email = field(root, "Firebase login email", InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS)
        password = field(root, "Firebase login password", InputType.TYPE_TEXT_VARIATION_PASSWORD)
        interval = field(root, "Update every (seconds, 15 recommended)", 0, numeric = true)
        k2t = field(root, "KarooTracker id (optional)", InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS)

        val buttons = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(0, dp(10), 0, 0)
        }
        buttons.addView(Button(this).apply {
            text = "Save"
            setOnClickListener { save(); toast("Saved") }
        }, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
        buttons.addView(Button(this).apply {
            text = "Save & test"
            setOnClickListener { test() }
        }, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
        root.addView(buttons, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))

        root.addView(TextView(this).apply {
            text = "Share link (scan with your phone)"
            textSize = 16f
            setTypeface(typeface, Typeface.BOLD)
            setPadding(0, dp(16), 0, dp(6))
        })
        qr = ImageView(this).apply { adjustViewBounds = true }
        root.addView(qr, LinearLayout.LayoutParams(dp(220), dp(220)).apply { gravity = Gravity.CENTER_HORIZONTAL })
        linkText = TextView(this).apply {
            textSize = 12f
            setTextIsSelectable(true)
            setPadding(0, dp(6), 0, dp(6))
        }
        root.addView(linkText)
        root.addView(Button(this).apply {
            text = "Make a new link"
            setOnClickListener {
                AlertDialog.Builder(this@MainActivity)
                    .setMessage("Create a new share link? The old link stops updating.")
                    .setPositiveButton("New link") { _, _ ->
                        settings.regenerateShareId()
                        settings.activeRideShareId = ""
                        if (settings.isConfigured) showLink()
                    }
                    .setNegativeButton("Cancel", null)
                    .show()
            }
        }, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))

        root.addView(TextView(this).apply {
            text = "Recent activity"
            textSize = 16f
            setTypeface(typeface, Typeface.BOLD)
            setPadding(0, dp(18), 0, dp(4))
        })
        logView = TextView(this).apply {
            textSize = 10f
            typeface = Typeface.MONOSPACE
            setTextIsSelectable(true)
            setPadding(dp(8), dp(6), dp(8), dp(6))
            setBackgroundColor(Color.argb(40, 128, 128, 128))
        }
        root.addView(logView, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
        root.addView(TextView(this).apply {
            text = "Full log: Android/data/io.github.madooroy.karoolive/files/logs"
            textSize = 11f
            alpha = 0.6f
            setPadding(0, dp(4), 0, 0)
        })

        root.addView(TextView(this).apply {
            text = "Setup guide: github.com/madooroy/karoo-live"
            textSize = 12f
            alpha = 0.7f
            setPadding(0, dp(14), 0, 0)
        })

        return ScrollView(this).apply { addView(root) }
    }

    private fun field(parent: LinearLayout, label: String, inputFlags: Int, numeric: Boolean = false): EditText {
        parent.addView(TextView(this).apply {
            text = label
            textSize = 13f
            alpha = 0.8f
            setPadding(0, dp(10), 0, 0)
        })
        val edit = EditText(this).apply {
            setSingleLine(true)
            textSize = 15f
            inputType = if (numeric) InputType.TYPE_CLASS_NUMBER else InputType.TYPE_CLASS_TEXT or inputFlags
        }
        parent.addView(edit, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
        return edit
    }
}
