plugins {
    alias(libs.plugins.android.test)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.baselineprofile)
}

/*
 * Velocidad (1.7.0): genera el Baseline Profile de :app y mide el arranque en frío y abrir un chat.
 * Corre contra el API de pruebas local con una cuenta de prueba (argumentos email/password); nunca contra producción.
 *   ./gradlew :app:generateBaselineProfile -Pandroid.testInstrumentationRunnerArguments.email=… -P…password=…
 *   ./gradlew :baselineprofile:connectedBenchmarkReleaseAndroidTest -P…class=com.tiecoms.baselineprofile.SpeedBenchmark
 */
android {
    namespace = "com.tiecoms.baselineprofile"
    compileSdk = 36
    defaultConfig {
        minSdk = 28
        targetSdk = 36
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        testInstrumentationRunnerArguments["androidx.benchmark.suppressErrors"] = "EMULATOR,DEBUGGABLE,LOW-BATTERY"
    }
    targetProjectPath = ":app"
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }

baselineProfile { useConnectedDevices = true }

dependencies {
    implementation(libs.androidx.test.ext.junit)
    implementation(libs.androidx.test.uiautomator)
    implementation(libs.androidx.benchmark.macro)
}
