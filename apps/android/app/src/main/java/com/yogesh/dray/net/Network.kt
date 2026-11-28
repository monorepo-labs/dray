package com.yogesh.dray.net

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.SystemClock
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Request
import okhttp3.Response
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume

/**
 * Whether the phone reaches the internet, so a server that stops answering while it does not reads
 * as "You're offline" rather than as that server's fault (the desktop's network.rs, #1703). The
 * system says when the default network moved; a probe decides, since a captive portal or a link
 * that carries nothing still reads as connected there. `changed` hears every verdict that moved,
 * and `wake` is true where every server should try again now.
 */
class Network(context: Context, private val scope: CoroutineScope, private val changed: (online: Boolean, wake: Boolean) -> Unit) {
    private val cm = context.getSystemService(ConnectivityManager::class.java)
    private var current: android.net.Network? = cm.activeNetwork
    private var validated: Boolean? = current?.let { cm.getNetworkCapabilities(it)?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) }
    private var checking: Job? = null
    private var upAt = 0L

    var online = current != null
        private set

    init {
        cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
            // Registering reports the network already up; only a different one is news.
            override fun onAvailable(network: android.net.Network) {
                scope.launch {
                    if (network == current) return@launch
                    current = network
                    validated = null
                    check(fresh = true)
                }
            }
            override fun onLost(network: android.net.Network) {
                scope.launch {
                    if (network != current) return@launch
                    current = null
                    check(fresh = true)
                }
            }
            // Android's own validation moving, as when a captive portal is signed into.
            override fun onCapabilitiesChanged(network: android.net.Network, caps: NetworkCapabilities) {
                val now = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
                scope.launch {
                    if (network != current || now == validated) return@launch
                    val known = validated != null
                    validated = now
                    if (known) check(fresh = true)
                }
            }
        })
        check(fresh = false)
    }

    /** A server stopped answering. Probes, unless one said the network was fine a moment ago. */
    fun suspect() = check(fresh = false)

    /**
     * Probes now, and while that fails keeps probing until it passes. `fresh` is the system saying
     * something moved: it skips the [TRUSTED] gap, restarts a probe under way, and wakes every
     * server once the network answers, since a move can leave a socket dead under a good network.
     */
    private fun check(fresh: Boolean) {
        if (!fresh && (checking?.isActive == true || online && SystemClock.elapsedRealtime() - upAt < TRUSTED)) return
        checking?.cancel()
        checking = scope.launch {
            var wake = fresh
            var wait = RECHECK_MS
            while (true) {
                val routed = current != null
                val up = routed && probe()
                if (up) upAt = SystemClock.elapsedRealtime()
                val was = online
                online = up
                if (up != was || up && wake) changed(up, up && (wake || !was))
                // With no network at all, the system's next word is what to wait for.
                if (up || !routed) break
                wake = false
                delay(wait)
                wait = minOf(wait * 2, MAX_RECHECK_MS)
            }
        }
    }

    /** Any answer from either host is a network. */
    private suspend fun probe(): Boolean = coroutineScope {
        val verdict = CompletableDeferred<Boolean>()
        var left = PROBES.size
        val tries = PROBES.map { url -> launch { if (reach(url)) verdict.complete(true) else if (--left == 0) verdict.complete(false) } }
        verdict.await().also { tries.forEach(Job::cancel) }
    }

    private suspend fun reach(url: String): Boolean = suspendCancellableCoroutine { cont ->
        val call = probing.newCall(Request.Builder().url(url).head().build())
        cont.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onResponse(call: Call, response: Response) {
                response.close()
                if (cont.isActive) cont.resume(true)
            }
            override fun onFailure(call: Call, e: IOException) {
                if (cont.isActive) cont.resume(false)
            }
        })
    }

    companion object {
        /** Over HTTPS, so a captive portal's own page fails the certificate rather than passing for an answer. Two hosts, so one down is not the network down. */
        private val PROBES = listOf("https://drayhq.com/", "https://github.com/")
        private val probing = http.newBuilder().callTimeout(3, TimeUnit.SECONDS).build()
        private const val RECHECK_MS = 2_000L
        private const val MAX_RECHECK_MS = 30_000L
        /** A server down with the network fine fails every backoff round, and each failure asks again; this caps that at one probe per gap. */
        private const val TRUSTED = 30_000L
    }
}

/** The words a call to an unreachable server fails with: Connection's own and the network stack's under them. */
private val CONNECTION_FAILURE = Regex(
    "not connected|disconnected|reconnecting|took too long to answer|failed to connect|unable to resolve host|" +
        "timeout|timed out|connection abort|connection reset|network is unreachable|socket closed|canceled",
    RegexOption.IGNORE_CASE,
)

/** Whether `message` is a failure being offline explains, which the offline line already says. */
fun connectionFailure(message: String): Boolean = CONNECTION_FAILURE.containsMatchIn(message)
