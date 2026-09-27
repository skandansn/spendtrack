package com.godsk.spendwatch

import android.content.Context
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/** One category's month-to-date position. */
data class Line(
    val category: String,
    val spent: Double,
    val lastMonth: Double,
    val budget: Double?,
)

/**
 * spendtrack's published spend summary: about a kilobyte of category totals.
 *
 * Always read from disk first and refreshed in the background, never fetched on
 * the path that draws the overlay. The overlay has to appear the instant a
 * shopping app opens; waiting on a network round trip there would mean it shows
 * up after you have already started browsing, or not at all on a bad connection.
 */
class Snapshot private constructor(
    val month: String,
    val dayOfMonth: Int,
    val daysInMonth: Int,
    val total: Double,
    val generatedAt: String,
    val lines: List<Line>,
) {
    fun line(category: String): Line? = lines.firstOrNull { it.category == category }

    /** How far through the month we are, for "ahead of pace" style wording. */
    val monthProgress: Double get() = if (daysInMonth == 0) 0.0 else dayOfMonth.toDouble() / daysInMonth

    companion object {
        private const val FILE = "snapshot.json"

        fun parse(json: String): Snapshot {
            val root = JSONObject(json)
            val array = root.getJSONArray("categories")
            val lines = ArrayList<Line>(array.length())
            for (i in 0 until array.length()) {
                val o = array.getJSONObject(i)
                lines.add(
                    Line(
                        category = o.getString("category"),
                        spent = o.optDouble("spent", 0.0),
                        lastMonth = o.optDouble("last_month", 0.0),
                        // budget is null when none is set; optDouble would turn that into NaN
                        budget = if (o.isNull("budget")) null else o.optDouble("budget"),
                    )
                )
            }
            return Snapshot(
                month = root.optString("month"),
                dayOfMonth = root.optInt("day_of_month"),
                daysInMonth = root.optInt("days_in_month", 30),
                total = root.optDouble("total", 0.0),
                generatedAt = root.optString("generated_at"),
                lines = lines,
            )
        }

        /** The last snapshot stored on this device, or null before the first fetch. */
        fun cached(context: Context): Snapshot? = runCatching {
            parse(context.getFileStreamPath(FILE).readText())
        }.getOrNull()

        fun cachedAt(context: Context): Long =
            context.getFileStreamPath(FILE).let { if (it.exists()) it.lastModified() else 0L }

        /**
         * Fetch and store. Returns null and leaves the cache untouched on any
         * failure - a stale figure beats no figure when you are at a till.
         */
        fun refresh(context: Context): Snapshot? {
            val prefs = Prefs(context)
            val url = prefs.url ?: return null
            val token = prefs.readToken ?: return null

            val body = runCatching {
                (URL(url).openConnection() as HttpURLConnection).run {
                    requestMethod = "GET"
                    connectTimeout = 8000
                    readTimeout = 8000
                    setRequestProperty("Authorization", "Bearer $token")
                    // Cloudflare answers the default Java agent with a 403
                    setRequestProperty("User-Agent", "spendwatch/1.0")
                    try {
                        if (responseCode != 200) null
                        else inputStream.bufferedReader().use { it.readText() }
                    } finally {
                        disconnect()
                    }
                }
            }.getOrNull() ?: return null

            val parsed = runCatching { parse(body) }.getOrNull() ?: return null
            runCatching {
                context.openFileOutput(FILE, Context.MODE_PRIVATE).use { it.write(body.toByteArray()) }
            }
            return parsed
        }
    }
}
