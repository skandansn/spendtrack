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
 * Deliberately not a blocker: it does not cover the screen, does not take focus
 * and passes every touch through. This is a reminder, not a lock - the moment it
 * gets in the way of actually buying something it will be switched off, and then
 * it warns you about nothing.
 */
class Cover(private val service: AccessibilityService) {

    /** One category line: "Restaurants  $123.06" over "Last month $820.35". */
    data class Row(val category: String, val amount: String, val note: String, val warn: Boolean)

    private val windows = service.getSystemService(WindowManager::class.java)
    private var view: View? = null
    private val hide = Runnable { dismiss() }

    fun show(title: String, rows: List<Row>, dwellSeconds: Int) {
        dismiss()
        if (rows.isEmpty()) return
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
                text = title
                textSize = 12f
                setTextColor(Color.parseColor("#898781"))
            })

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
            // Not touchable and not focusable: taps go to the app underneath, so
            // the card can never stop you completing a purchase.
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
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
        view?.let { existing ->
            existing.removeCallbacks(hide)
            runCatching { windows.removeView(existing) }
        }
        view = null
    }
}
