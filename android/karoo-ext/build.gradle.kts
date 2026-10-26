// Vendored copy of Hammerhead's karoo-ext library (Apache 2.0, see LICENSE in this folder).
// Source: https://github.com/hammerheadnav/karoo-ext (lib/) — built from source so no
// GitHub Packages credentials are needed.
plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.serialization")
}

android {
    namespace = "io.hammerhead.karooext"
    compileSdk = 34

    defaultConfig {
        minSdk = 23
        buildConfigField("String", "LIB_VERSION", "\"1.1.9\"")
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
        aidl = true
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    api("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.3")
    api("com.jakewharton.timber:timber:5.0.1")
}
