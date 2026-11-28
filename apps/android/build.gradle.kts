plugins {
    id("com.android.application") version "9.5.2" apply false
    // AGP 9 compiles Kotlin itself, so there is no kotlin-android plugin; the version here is the Kotlin it uses.
    id("org.jetbrains.kotlin.plugin.compose") version "2.4.21" apply false
    id("org.jetbrains.kotlin.plugin.serialization") version "2.4.21" apply false
    id("com.google.gms.google-services") version "4.6.0" apply false
}
