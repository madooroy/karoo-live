plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.serialization")
}

val appVersionName = "0.5.0"
val appVersionCode = 8

android {
    namespace = "io.github.madooroy.karoolive"
    compileSdk = 34

    defaultConfig {
        applicationId = "io.github.madooroy.karoolive"
        minSdk = 23
        targetSdk = 34
        versionCode = appVersionCode
        versionName = appVersionName
    }

    signingConfigs {
        // A fixed key is committed so every build can install over the previous one.
        // It is NOT a secret. To sign with your own key, set the KAROO_LIVE_KEYSTORE* env vars.
        create("shared") {
            val customStore = System.getenv("KAROO_LIVE_KEYSTORE")
            if (customStore != null) {
                storeFile = file(customStore)
                storePassword = System.getenv("KAROO_LIVE_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("KAROO_LIVE_KEY_ALIAS")
                keyPassword = System.getenv("KAROO_LIVE_KEY_PASSWORD")
            } else {
                storeFile = file("karoo-live.keystore")
                storePassword = "karoolive"
                keyAlias = "karoolive"
                keyPassword = "karoolive"
            }
        }
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.getByName("shared")
            isMinifyEnabled = false
        }
        debug {
            signingConfig = signingConfigs.getByName("shared")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

dependencies {
    implementation(project(":karoo-ext"))
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.0")
    implementation("com.google.zxing:core:3.5.3")
    testImplementation("junit:junit:4.13.2")
}

// Writes manifest.json next to the APK so the Karoo can find updates (see MANIFEST_URL in AndroidManifest.xml).
tasks.register("karooManifest") {
    val out = layout.buildDirectory.file("outputs/karoo/manifest.json")
    outputs.file(out)
    doLast {
        val f = out.get().asFile
        f.parentFile.mkdirs()
        f.writeText(
            """
            {
              "label": "Karoo Live",
              "packageName": "io.github.madooroy.karoolive",
              "iconUrl": "https://github.com/madooroy/karoo-live/releases/latest/download/karoo-live.png",
              "latestApkUrl": "https://github.com/madooroy/karoo-live/releases/latest/download/karoo-live.apk",
              "latestVersion": "$appVersionName",
              "latestVersionCode": $appVersionCode,
              "developer": "madooroy",
              "description": "Live tracking with speed, power, cadence and heart rate on a shareable web page, using your own free Firebase database.",
              "releaseNotes": "See github.com/madooroy/karoo-live/releases",
              "tags": ["tracking"]
            }
            """.trimIndent() + "\n",
        )
    }
}
