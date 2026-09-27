package com.godsk.spendwatch

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.provider.Settings
import android.text.InputType
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors

/** Setup and status. Endpoint, read token, and whether the service is running. */
class MainActivity : Activity() {

    private val io = Executors.newSingleThreadExecutor()
    private lateinit var prefs: Prefs
    private lateinit var status: TextView
    private lateinit var urlField: EditText
    private lateinit var tokenField: EditText

    override fun onCreate(saved: Bundle?) {
        super.onCreate(saved)
        prefs = Prefs(this)
        val density = resources.displayMetrics.density
        fun dp(v: Int) = (v * density).toInt()

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(32), dp(24), dp(32))
            setBackgroundColor(Color.parseColor("#0D0D0D"))
        }

        fun label(text: String) = TextView(this).apply {
            this.text = text
            textSize = 12f
            setTextColor(Color.parseColor("#898781"))
            setPadding(0, dp(16), 0, dp(4))
        }

        fun field(hint: String, password: Boolean) = EditText(this).apply {
            this.hint = hint
            setTextColor(Color.WHITE)
            setHintTextColor(Color.parseColor("#66655F"))
            textSize = 14f
            setSingleLine()
            if (password) inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        }

        root.addView(TextView(this).apply {
            text = "SpendWatch"
            textSize = 24f
            setTextColor(Color.WHITE)
        })
        root.addView(TextView(this).apply {
            text = "Shows what a category has cost you this month, when you open a shopping app."
            textSize = 13f
            setTextColor(Color.parseColor("#C3C2B7"))
            setPadding(0, dp(6), 0, 0)
        })

        status = TextView(this).apply {
            textSize = 13f
            setPadding(0, dp(18), 0, 0)
        }
        root.addView(status)

        root.addView(label("Snapshot URL"))
        urlField = field("https://spendtrack-snapshot.<you>.workers.dev/snapshot", false)
        urlField.setText(prefs.url ?: "")
        root.addView(urlField)

        root.addView(label("Read token"))
        tokenField = field("the READ_TOKEN from the Worker", true)
        tokenField.setText(prefs.readToken ?: "")
        root.addView(tokenField)

        root.addView(Button(this).apply {
            text = "Save and test"
            setPadding(0, dp(8), 0, dp(8))
            setOnClickListener { saveAndTest() }
        })

        root.addView(Button(this).apply {
            text = "Accessibility settings"
            setOnClickListener {
                startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
            }
        })

        root.addView(TextView(this).apply {
            text = "SpendWatch needs the accessibility permission to notice which app is in " +
                "front. It only listens for the shopping apps it knows about, reads nothing " +
                "from the screen, and never touches the network except to fetch your own " +
                "spend summary."
            textSize = 12f
            setTextColor(Color.parseColor("#898781"))
            setPadding(0, dp(20), 0, 0)
        })

        setContentView(ScrollView(this).apply {
            addView(root, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            setBackgroundColor(Color.parseColor("#0D0D0D"))
        })
    }

    override fun onResume() {
        super.onResume()
        showStatus()
    }

    private fun showStatus() {
        val enabled = isServiceEnabled()
        val cached = Snapshot.cached(this)
        val at = Snapshot.cachedAt(this)
        val when_ = if (at == 0L) "never" else
            SimpleDateFormat("d MMM, HH:mm", Locale.getDefault()).format(Date(at))

        status.text = buildString {
            append(if (enabled) "Service on" else "Service OFF - turn it on below")
            append("\nLast snapshot: ").append(when_)
            if (cached != null) {
                append(" (").append(cached.lines.size).append(" categories, ")
                append("$%.2f".format(cached.total)).append(" this month)")
            }
        }
        status.setTextColor(Color.parseColor(if (enabled) "#0CA30C" else "#E66767"))
    }

    private fun isServiceEnabled(): Boolean {
        val flat = Settings.Secure.getString(
            contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: return false
        return flat.split(':').any { it.startsWith("$packageName/") }
    }

    private fun saveAndTest() {
        prefs.url = urlField.text.toString()
        prefs.readToken = tokenField.text.toString()
        if (!prefs.configured) {
            Toast.makeText(this, "Both fields are needed", Toast.LENGTH_SHORT).show()
            return
        }
        Toast.makeText(this, "Fetching...", Toast.LENGTH_SHORT).show()
        io.execute {
            val snapshot = Snapshot.refresh(this)
            runOnUiThread {
                if (snapshot == null) {
                    Toast.makeText(this, "Could not fetch - check URL and token",
                        Toast.LENGTH_LONG).show()
                } else {
                    val top = snapshot.lines.firstOrNull()
                    Toast.makeText(
                        this,
                        "Got ${snapshot.lines.size} categories" +
                            (top?.let { ", top: ${it.category} $%.2f".format(it.spent) } ?: ""),
                        Toast.LENGTH_LONG,
                    ).show()
                }
                showStatus()
            }
        }
    }

    override fun onDestroy() {
        io.shutdownNow()
        super.onDestroy()
    }
}
