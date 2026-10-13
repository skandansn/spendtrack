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
     * How long the card stays suppressed for an app after you have seen it once.
     * Within this window the figures go to the notification shade instead. One
     * card per app per half hour is a nudge; every time is nagging, and nagging
     * gets the service turned off.
     */
    var quietMinutes: Int
        get() = store.getInt("quiet", 30)
        set(value) = store.edit().putInt("quiet", value).apply()

    val configured: Boolean get() = url != null && readToken != null

    private val cardShownAt = HashMap<String, Long>()

    /** True the first time an app comes forward in the quiet window. */
    fun shouldShowCard(packageName: String): Boolean {
        val now = System.currentTimeMillis()
        val last = cardShownAt[packageName] ?: 0L
        return now - last >= quietMinutes * 60_000L
    }

    /** Start the quiet window: called when the card is actually drawn. */
    fun markCardShown(packageName: String) {
        cardShownAt[packageName] = System.currentTimeMillis()
    }
}
