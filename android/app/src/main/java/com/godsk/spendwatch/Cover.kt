package com.godsk.spendwatch

import android.accessibilityservice.AccessibilityService
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView

/**
 * A card that floats over a shopping app with what you have already spent in
 * that app's categories this month. One row per category, because an app like
 * Uber spends out of two different budgets.
 *
 * Deliberately not a blocker: it does not cover the screen and does not take
 * focus. It is touchable only within its own bounds, so a tap dismisses it and
 * every touch outside it still reaches the app underneath. This is a reminder,
 * not a lock - the moment it gets in the way of actually buying something it
 * will be switched off, and then it warns you about nothing.
 */
class Cover(private val service: AccessibilityService) {

    /** One category line: "Restaurants  $123.06" over "Last month $820.35". */
    data class Row(val category: String, val amount: String, val note: String, val warn: Boolean)

    private val windows = service.getSystemService(WindowManager::class.java)
    private var view: View? = null
    private var onDismiss: (() -> Unit)? = null
    private val hide = Runnable { dismiss() }

    /**
     * [onDismiss] fires however the card goes away - tapped or timed out - so
     * the caller can move the same figures to the notification shade.
     */
    fun show(title: String, rows: List<Row>, dwellSeconds: Int, onDismiss: () -> Unit) {
        dismiss()
        if (rows.isEmpty()) return
        this.onDismiss = onDismiss
        val density = service.resources.displayMetrics.density
        fun dp(value: Int) = (value * density).toInt()
        val anyWarning = rows.any { it.warn }

        val card = LinearLayout(service).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(14), dp(18), dp(14))
            background = GradientDrawable().apply {
                cornerRadius = dp(18).toFloat()
                setColor(Color.parseColor("#F21A1A19"))
                setStroke(dp(1), Color.parseColor(if (anyWarning) "#E66767" else "#3987E5"))
            }
            elevation = dp(8).toFloat()

            addView(TextView(service).apply {
                text = "$title   -   tap to dismiss"
                textSize = 12f
                setTextColor(Color.parseColor("#898781"))
            })
            setOnClickListener { dismiss() }

            rows.forEachIndexed { index, row ->
                addView(LinearLayout(service).apply {
                    orientation = LinearLayout.HORIZONTAL
                    setPadding(0, dp(if (index == 0) 6 else 10), 0, 0)
                    addView(TextView(service).apply {
                        text = row.category
                        textSize = 16f
                        setTextColor(Color.WHITE)
                    })
                    addView(TextView(service).apply {
                        text = row.amount
                        textSize = 16f
                        setTextColor(Color.parseColor(if (row.warn) "#E66767" else "#FFFFFF"))
                        setPadding(dp(10), 0, 0, 0)
                    })
                })
                addView(TextView(service).apply {
                    text = row.note
                    textSize = 12f
                    setTextColor(Color.parseColor("#C3C2B7"))
                })
            }
        }

        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            // Touchable so a tap can dismiss it, but WRAP_CONTENT means the
            // window is only as big as the card - anything outside those bounds
            // still goes straight to the app, so a purchase can never be blocked.
            // Not focusable, so it never steals the keyboard or the back gesture.
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL
            y = dp(64)
        }

        runCatching { windows.addView(card, params) }.onSuccess { view = card }
        if (dwellSeconds > 0) card.postDelayed(hide, dwellSeconds * 1000L)
    }

    fun dismiss() {
        val existing = view ?: return
        existing.removeCallbacks(hide)
        runCatching { windows.removeView(existing) }
        view = null
        // taken before invoking, so a callback that shows something else cannot
        // re-enter this and fire twice
        val callback = onDismiss
        onDismiss = null
        callback?.invoke()
    }
}
