plugins {
    id("com.android.application")
}

android {
    namespace = "com.godsk.spendwatch"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.godsk.spendwatch"
        minSdk = 34
        targetSdk = 37
        versionCode = 1
        versionName = "0.1"
    }

    buildFeatures {
        buildConfig = true
    }
}
