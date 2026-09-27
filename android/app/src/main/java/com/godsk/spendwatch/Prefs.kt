package com.godsk.spendwatch

import android.content.Context

/**
 * Settings. The endpoint and read token are entered on the setup screen rather
 * than compiled in, so the APK carries no secret and can be rebuilt freely.
 */
class Prefs(context: Context) {
    private val store = context.getSharedPreferences("spendwatch", Context.MODE_PRIVATE)

    var url: String?
        get() = store.getString("url", null)?.ifBlank { null }
        set(value) = store.edit().putString("url", value?.trim()).apply()

    var readToken: String?
        get() = store.getString("token", null)?.ifBlank { null }
        set(value) = store.edit().putString("token", value?.trim()).apply()

    /** Seconds the overlay stays up before fading. 0 means until dismissed. */
    var dwellSeconds: Int
        get() = store.getInt("dwell", 6)
        set(value) = store.edit().putInt("dwell", value).apply()

    /**
     * Don't redraw the same warning every time you switch back to an app. One
     * reminder per app per this many minutes is a nudge; every time is nagging,
     * and nagging gets the service turned off.
     */
    var quietMinutes: Int
        get() = store.getInt("quiet", 30)
        set(value) = store.edit().putInt("quiet", value).apply()

    val configured: Boolean get() = url != null && readToken != null

    private val shownAt = HashMap<String, Long>()

    fun shouldShow(packageName: String): Boolean {
        val now = System.currentTimeMillis()
        val last = shownAt[packageName] ?: 0L
        if (now - last < quietMinutes * 60_000L) return false
        shownAt[packageName] = now
        return true
    }
}
