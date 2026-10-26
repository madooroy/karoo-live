package io.github.madooroy.karoolive

import io.hammerhead.karooext.KarooSystemService
import io.hammerhead.karooext.models.HttpResponseState
import io.hammerhead.karooext.models.OnHttpResponse
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import timber.log.Timber
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.resume

data class HttpResult(val code: Int, val body: String, val error: String? = null) {
    val ok: Boolean get() = error == null && code in 200..299
}

/**
 * Sends requests through the Karoo system first (it knows about SIM, Wi-Fi and, on the
 * newer Karoo, the Companion App connection). Falls back to a direct connection if the
 * Karoo system is unavailable or reports a transport error.
 *
 * PATCH is sent as POST + X-HTTP-Method-Override, which Firebase supports and which works
 * on every Android HTTP stack.
 */
class Http(private val karooSystem: KarooSystemService) {

    suspend fun request(method: String, url: String, body: String? = null, contentType: String = "application/json"): HttpResult {
        val headers = mutableMapOf<String, String>()
        var realMethod = method
        if (method == "PATCH") {
            realMethod = "POST"
            headers["X-HTTP-Method-Override"] = "PATCH"
        }
        if (body != null) headers["Content-Type"] = contentType

        if (karooSystem.connected) {
            val viaKaroo = viaKarooSystem(realMethod, url, headers, body)
            // Any real HTTP status came from the server; only retry directly on transport failures.
            if (viaKaroo != null && viaKaroo.code > 0) return viaKaroo
            Timber.w("Karoo system HTTP failed (${viaKaroo?.error ?: "timeout"}), trying direct")
        }
        return direct(realMethod, url, headers, body)
    }

    private suspend fun viaKarooSystem(method: String, url: String, headers: Map<String, String>, body: String?): HttpResult? {
        val bytes = body?.toByteArray(Charsets.UTF_8)
        if (bytes != null && bytes.size > OnHttpResponse.MAX_REQUEST_SIZE) {
            return HttpResult(0, "", "Request too large for Karoo system")
        }
        val params = try {
            OnHttpResponse.MakeHttpRequest(method = method, url = url, headers = headers, body = bytes, waitForConnection = false)
        } catch (e: Exception) {
            return HttpResult(0, "", e.message ?: "bad request")
        }
        return withTimeoutOrNull(30_000L) {
            suspendCancellableCoroutine { cont ->
                val done = AtomicBoolean(false)
                var consumerId: String? = null
                fun finish(result: HttpResult) {
                    if (done.compareAndSet(false, true)) {
                        consumerId?.let { karooSystem.removeConsumer(it) }
                        cont.resume(result)
                    }
                }
                consumerId = karooSystem.addConsumer<OnHttpResponse>(
                    params,
                    onError = { msg -> finish(HttpResult(0, "", msg)) },
                    onComplete = { finish(HttpResult(0, "", "completed without response")) },
                ) { event ->
                    val state = event.state
                    if (state is HttpResponseState.Complete) {
                        val text = state.body?.toString(Charsets.UTF_8) ?: ""
                        val err = if (state.statusCode <= 0) (state.error ?: "no connection") else null
                        finish(HttpResult(state.statusCode, text, err))
                    }
                }
                cont.invokeOnCancellation {
                    if (done.compareAndSet(false, true)) consumerId?.let { karooSystem.removeConsumer(it) }
                }
            }
        }
    }

    private suspend fun direct(method: String, url: String, headers: Map<String, String>, body: String?): HttpResult =
        withContext(Dispatchers.IO) {
            var conn: HttpURLConnection? = null
            try {
                conn = (URL(url).openConnection() as HttpURLConnection).apply {
                    requestMethod = method
                    connectTimeout = 15_000
                    readTimeout = 20_000
                    headers.forEach { (k, v) -> setRequestProperty(k, v) }
                    if (body != null) {
                        doOutput = true
                        outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                    }
                }
                val code = conn.responseCode
                val stream = if (code in 200..299) conn.inputStream else conn.errorStream
                val text = stream?.bufferedReader()?.use { it.readText() } ?: ""
                HttpResult(code, text)
            } catch (e: Exception) {
                Timber.w("Direct connection failed: ${e.javaClass.simpleName}: ${e.message}")
                HttpResult(0, "", e.message ?: e.javaClass.simpleName)
            } finally {
                conn?.disconnect()
            }
        }
}
