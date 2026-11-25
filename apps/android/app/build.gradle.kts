import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

// Push lights up once the Firebase project's `google-services.json` sits beside this file.
// Without it the app still builds, and Settings → Notifications says push isn't set up.
if (file("google-services.json").exists()) apply(plugin = "com.google.gms.google-services")

// Play upload key: `keystore.properties` beside the project root, or the same four values as
// DRAY_ANDROID_* env vars. Without them a release build still configures, just unsigned.
val keystoreProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
fun signingValue(key: String, env: String): String? =
    keystoreProps.getProperty(key) ?: System.getenv(env)?.takeIf { it.isNotEmpty() }
val uploadSigning = listOf(
    signingValue("storeFile", "DRAY_ANDROID_STORE_FILE"),
    signingValue("storePassword", "DRAY_ANDROID_STORE_PASSWORD"),
    signingValue("keyAlias", "DRAY_ANDROID_KEY_ALIAS"),
    signingValue("keyPassword", "DRAY_ANDROID_KEY_PASSWORD"),
).takeIf { values -> values.all { it != null } }?.map { it!! }

android {
    namespace = "com.yogesh.dray"
    // AndroidX now asks for 37.1 or later; targetSdk stays at what Play requires.
    compileSdk { version = release(37) { minorApiLevel = 2 } }

    defaultConfig {
        applicationId = "com.dray.app"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
        // The push relay. A debug build can be pointed at a local one with the `pushRelay` intent extra.
        buildConfigField("String", "PUSH_RELAY", "\"https://drayhq.com\"")
    }

    signingConfigs {
        if (uploadSigning != null) create("upload") {
            val (store, storePass, alias, keyPass) = uploadSigning
            storeFile = rootProject.file(store)
            storePassword = storePass
            keyAlias = alias
            keyPassword = keyPass
        }
    }

    buildTypes {
        release {
            signingConfigs.findByName("upload")?.let { signingConfig = it }
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    testOptions { unitTests.isReturnDefaultValues = true }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2026.11.01")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.core:core-ktx:1.19.1")
    implementation("androidx.lifecycle:lifecycle-process:2.11.1")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.11.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.13.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("androidx.media3:media3-exoplayer:1.11.1")
    implementation("androidx.media3:media3-datasource-okhttp:1.11.1")
    implementation("androidx.media3:media3-ui:1.11.1")
    implementation("androidx.camera:camera-camera2:1.7.0")
    implementation("androidx.camera:camera-lifecycle:1.7.0")
    implementation("androidx.camera:camera-view:1.7.0")
    implementation("com.google.mlkit:barcode-scanning:17.3.0")
    implementation("com.caverock:androidsvg-aar:1.4")
    implementation("com.github.yogesharc:thinking-orbs:0.1.3")
    implementation(platform("com.google.firebase:firebase-bom:33.7.0"))
    implementation("com.google.firebase:firebase-messaging")

    debugImplementation("androidx.compose.ui:ui-tooling")
    testImplementation("junit:junit:4.13.2")
}
