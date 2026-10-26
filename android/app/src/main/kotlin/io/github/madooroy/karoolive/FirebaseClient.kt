package io.github.madooroy.karoolive

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.net.URLEncoder

class FirebaseException(message: String) : Exception(message)

/**
 * Minimal Firebase client using only REST:
 *  - Email/password sign-in via the Identity Toolkit API (token cached and refreshed)
 *  - Realtime Database reads/writes via `https://<db>/path.json?auth=<idToken>`
 */
class FirebaseClient(private val settings: Settings, private val http: Http) {
    private val json = Json { ignoreUnknownKeys = true }

    private var idToken: String? = null
    private var idTokenExpiresAt = 0L
    var uid: String? = null
        private set

    fun resetAuth() {
        tokenFor = ""
        idToken = null
        idTokenExpiresAt = 0L
        uid = null
        settings.refreshToken = ""
    }

    private var tokenFor = ""

    private suspend fun token(): String {
        val key = "${settings.databaseHost}|${settings.apiKey}|${settings.email}|${settings.password.hashCode()}"
        if (key != tokenFor) {
            // Settings changed since this token was issued (possibly from the settings screen).
            idToken = null
            uid = null
            tokenFor = key
        }
        val now = System.currentTimeMillis()
        idToken?.let { if (now < idTokenExpiresAt - 60_000) return it }
        if (settings.refreshToken.isNotBlank() && settings.authEmail == settings.email) {
            if (refresh()) return idToken!!
        }
        signIn()
        return idToken!!
    }

    private suspend fun signIn() {
        val body = buildJsonObject {
            put("email", settings.email)
            put("password", settings.password)
            put("returnSecureToken", true)
        }.toString()
        val res = http.request("POST", "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${enc(settings.apiKey)}", body)
        if (!res.ok) throw FirebaseException("Sign-in failed: ${describeError(res)}")
        val obj = json.parseToJsonElement(res.body).jsonObject
        idToken = obj.str("idToken") ?: throw FirebaseException("Sign-in: no token returned")
        uid = obj.str("localId")
        idTokenExpiresAt = System.currentTimeMillis() + (obj.str("expiresIn")?.toLongOrNull() ?: 3600L) * 1000
        settings.refreshToken = obj.str("refreshToken") ?: ""
        settings.authEmail = settings.email
    }

    private suspend fun refresh(): Boolean {
        val form = "grant_type=refresh_token&refresh_token=${enc(settings.refreshToken)}"
        val res = http.request("POST", "https://securetoken.googleapis.com/v1/token?key=${enc(settings.apiKey)}", form, "application/x-www-form-urlencoded")
        if (!res.ok) {
            settings.refreshToken = ""
            return false
        }
        val obj = json.parseToJsonElement(res.body).jsonObject
        idToken = obj.str("id_token") ?: return false
        uid = obj.str("user_id")
        idTokenExpiresAt = System.currentTimeMillis() + (obj.str("expires_in")?.toLongOrNull() ?: 3600L) * 1000
        obj.str("refresh_token")?.let { settings.refreshToken = it }
        return true
    }

    private fun url(path: String, token: String): String {
        val host = settings.databaseHost
        if (host.isBlank()) throw FirebaseException("Database URL is not set")
        return "https://$host/${path.trim('/')}.json?auth=${enc(token)}"
    }

    /** Runs a database request, re-authenticating once if the token was rejected. */
    private suspend fun db(method: String, path: String, body: JsonElement? = null): JsonElement {
        var attempt = 0
        while (true) {
            val res = http.request(method, url(path, token()), body?.toString())
            if (res.ok) {
                return if (res.body.isBlank()) JsonNull else json.parseToJsonElement(res.body)
            }
            if ((res.code == 401 || res.code == 403) && attempt == 0) {
                // Token might be stale or revoked; get a fresh one and retry once.
                idToken = null
                attempt++
                continue
            }
            throw FirebaseException("$method /$path failed: ${describeError(res)}")
        }
    }

    suspend fun get(path: String): JsonElement = db("GET", path)
    suspend fun put(path: String, value: JsonElement) { db("PUT", path, value) }
    suspend fun patch(path: String, value: JsonObject) { db("PATCH", path, value) }

    /**
     * The database rules let the first signed-in account claim `/owner`; after that only the
     * owner can write. Returns normally if this account is (now) the owner.
     */
    suspend fun ensureOwner() {
        token()
        val me = uid ?: throw FirebaseException("Signed in but no user id")
        val current = (get("owner") as? JsonPrimitive)?.contentOrNull
        when {
            current == null -> put("owner", JsonPrimitive(me))
            current != me -> throw FirebaseException("This database is owned by a different Firebase account")
        }
    }

    private fun describeError(res: HttpResult): String {
        if (res.error != null) return res.error
        val msg = try {
            val obj = json.parseToJsonElement(res.body).jsonObject
            val err = obj["error"]
            when (err) {
                is JsonObject -> err.str("message")
                is JsonPrimitive -> err.contentOrNull
                else -> null
            } ?: obj.str("error_description")
        } catch (e: Exception) {
            null
        }
        val friendly = when (msg) {
            "INVALID_LOGIN_CREDENTIALS", "INVALID_PASSWORD", "EMAIL_NOT_FOUND" -> "wrong email or password"
            "Permission denied" -> "permission denied (check database rules)"
            null -> res.body.take(120)
            else -> msg
        }
        return "HTTP ${res.code}: $friendly"
    }

    private fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")

    companion object {
        /** Firebase server timestamp placeholder. */
        val SERVER_TIME: JsonObject = buildJsonObject { put(".sv", "timestamp") }
    }
}
