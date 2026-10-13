package com.godsk.spendwatch

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context

/**
 * The quiet half of the warning.
 *
 * Once the card has been seen and dismissed, repeating it over the app is
 * nagging. The same figures go to the notification shade instead, where they
 * stay available without interrupting anything.
 *
 * IMPORTANCE_LOW is the point: it appears in the shade with no sound, no
 * vibration and no heads-up peek. A spending reminder that buzzes gets the
 * whole app turned off.
 */
object Notifier {

    private const val CHANNEL = "spend"
    private const val ID = 1

    fun ensureChannel(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL) != null) return
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL, "Spending so far", NotificationManager.IMPORTANCE_LOW)
                .apply {
                    description = "What a category has cost this month, shown silently."
                    setShowBadge(false)
                    enableVibration(false)
                    setSound(null, null)
                }
        )
    }

    /**
     * Post or replace the reminder. One notification id throughout, so opening
     * four shops leaves one entry rather than four.
     */
    fun show(context: Context, title: String, rows: List<Cover.Row>) {
        if (rows.isEmpty()) return
        ensureChannel(context)
        val manager = context.getSystemService(NotificationManager::class.java) ?: return

        val summary = rows.joinToString("  ·  ") { "${it.category} ${it.amount}" }
        val detail = rows.joinToString("\n") { "${it.category}  ${it.amount}\n${it.note}" }

        val notification = Notification.Builder(context, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_menu_info_details)
            .setContentTitle(title)
            .setContentText(summary)
            .setStyle(Notification.BigTextStyle().bigText(detail))
            .setOnlyAlertOnce(true)
            .setAutoCancel(true)
            .setCategory(Notification.CATEGORY_STATUS)
            .build()

        runCatching { manager.notify(ID, notification) }
    }

    fun clear(context: Context) {
        runCatching {
            context.getSystemService(NotificationManager::class.java)?.cancel(ID)
        }
    }
}
