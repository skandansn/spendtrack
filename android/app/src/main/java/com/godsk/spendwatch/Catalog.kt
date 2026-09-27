package com.godsk.spendwatch

/**
 * Which spendtrack categories an app's purchases land in, and what to call it.
 *
 * A list rather than one category, because plenty of apps are several shops in a
 * trench coat: Uber is rides and food from the same icon, Amazon is general
 * retail and groceries. Showing both lines is honest; guessing one and being
 * wrong half the time teaches you to ignore the card.
 *
 * Deliberately app-level rather than reading baskets out of each app's view
 * tree: a package name is stable across releases, whereas a checkout screen's
 * node ids are not. Getting the right number on screen when you open the app is
 * most of the value, and it keeps working after every app update.
 */
object Catalog {

    data class Entry(val label: String, val categories: List<String>)

    private val byPackage = mapOf(
        // Uber is one icon for two very different budgets
        "com.ubercab" to Entry("Uber", listOf("Transport", "Restaurants")),
        "com.ubercab.eats" to Entry("Uber Eats", listOf("Restaurants")),
        "me.lyft.android" to Entry("Lyft", listOf("Transport")),

        "com.dd.doordash" to Entry("DoorDash", listOf("Restaurants")),
        "com.grubhub.android" to Entry("Grubhub", listOf("Restaurants")),
        "com.chipotle.ordering" to Entry("Chipotle", listOf("Restaurants")),
        "com.starbucks.mobilecard" to Entry("Starbucks", listOf("Coffee")),
        "com.dunkinbrands.otgo" to Entry("Dunkin'", listOf("Coffee")),

        "com.instacart.client" to Entry("Instacart", listOf("Groceries")),
        "com.kroger.mobile" to Entry("Kroger", listOf("Groceries")),
        "com.publix.android" to Entry("Publix", listOf("Groceries")),
        "com.wholefoods.wholefoodsmarket" to Entry("Whole Foods", listOf("Groceries")),

        // general retail that also sells food
        "com.amazon.mShop.android.shopping" to Entry("Amazon", listOf("Shopping", "Groceries")),
        "com.walmart.android" to Entry("Walmart", listOf("Shopping", "Groceries")),
        "com.target.ui" to Entry("Target", listOf("Shopping", "Groceries")),

        "com.ebay.mobile" to Entry("eBay", listOf("Shopping")),
        "com.einnovation.temu" to Entry("Temu", listOf("Shopping")),
        "com.zzkko" to Entry("Shein", listOf("Shopping")),
        "com.bestbuy.android" to Entry("Best Buy", listOf("Shopping")),

        "com.delta.mobile.android" to Entry("Delta", listOf("Travel")),
        "com.united.mobile.android" to Entry("United", listOf("Travel")),
        "com.airbnb.android" to Entry("Airbnb", listOf("Travel")),
        "com.booking" to Entry("Booking.com", listOf("Travel")),
        "com.expedia.bookings" to Entry("Expedia", listOf("Travel")),
    )

    /** Every package worth listening to, for the service's package filter. */
    val packages: Array<String> get() = byPackage.keys.toTypedArray()

    fun entryFor(packageName: String?): Entry? = byPackage[packageName]
}
