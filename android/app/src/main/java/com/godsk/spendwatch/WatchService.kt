package com.godsk.spendwatch

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.view.accessibility.AccessibilityEvent
import java.util.concurrent.Executors
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * Watches for a shopping app coming to the front and shows what its categories
 * have already cost this month.
 *
 * Only TYPE_WINDOW_STATE_CHANGED, and only for the packages in [Catalog]. Both
 * limits are about battery: content events from a scrolling shopping feed arrive
 * continuously and there is nothing useful to do with them.
 */
class WatchService : AccessibilityService() {

    private lateinit var prefs: Prefs
    private lateinit var cover: Cover
    private val io = Executors.newSingleThreadExecutor()
    @Volatile private var snapshot: Snapshot? = null

    override fun onServiceConnected() {
        prefs = Prefs(this)
        cover = Cover(this)
        serviceInfo = AccessibilityServiceInfo().apply {
            eventTypes = AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
            feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC
            flags = AccessibilityServiceInfo.DEFAULT
            packageNames = Catalog.packages
            notificationTimeout = 100
        }
        snapshot = Snapshot.cached(this)
        refreshIfStale()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        val packageName = event?.packageName?.toString() ?: return
        val entry = Catalog.entryFor(packageName) ?: return
        if (!prefs.shouldShow(packageName)) return

        refreshIfStale()
        val snap = snapshot
        val rows = entry.categories.map { category -> row(category, snap) }
        cover.show(title = entry.label, rows = rows, dwellSeconds = prefs.dwellSeconds)
    }

    private fun row(category: String, snap: Snapshot?): Cover.Row {
        val line = snap?.line(category)
        if (snap == null || line == null) {
            return Cover.Row(
                category = category,
                amount = "--",
                note = if (snap == null) "No figures yet - open SpendWatch"
                       else "Nothing this month",
                warn = false,
            )
        }

        val budget = line.budget
        if (budget != null && budget > 0) {
            val left = budget - line.spent
            val note = if (left < 0) {
                "${money(-left)} over your ${money(budget)} budget"
            } else {
                val pace = budget * snap.monthProgress
                "${money(left)} left of ${money(budget)}  " +
                    (if (line.spent > pace) "- ahead of pace" else "- on track")
            }
            return Cover.Row(category, money(line.spent), note, warn = line.spent > pace(budget, snap))
        }

        // With no budget set, last month is the only honest yardstick.
        val last = line.lastMonth
        if (last <= 0) {
            return Cover.Row(category, money(line.spent),
                "Day ${snap.dayOfMonth} of ${snap.daysInMonth}", warn = false)
        }
        val projected = if (snap.monthProgress > 0) line.spent / snap.monthProgress else line.spent
        val delta = ((projected - last) / last * 100).roundToInt()
        val sign = if (delta >= 0) "+" else ""
        return Cover.Row(
            category = category,
            amount = money(line.spent),
            note = "Last month ${money(last)}  - heading for ${money(projected)} ($sign$delta%)",
            warn = projected > last * 1.15,
        )
    }

    private fun pace(budget: Double, snap: Snapshot) = budget * snap.monthProgress

    /**
     * Refresh at most once an hour, off the event thread. Never blocks the
     * overlay: whatever is cached is what gets drawn right now, and a newer
     * snapshot lands in time for the next app you open.
     */
    private fun refreshIfStale() {
        if (!prefs.configured) return
        val age = System.currentTimeMillis() - Snapshot.cachedAt(this)
        if (age < 60 * 60 * 1000L) return
        io.execute { Snapshot.refresh(this)?.let { snapshot = it } }
    }

    private fun money(value: Double): String =
        if (abs(value) >= 1000) "$%,.0f".format(value) else "$%.2f".format(value)

    override fun onInterrupt() = cover.dismiss()

    override fun onDestroy() {
        cover.dismiss()
        io.shutdownNow()
        super.onDestroy()
    }
}
