import java.io.File
import java.util.Properties
import groovy.json.JsonSlurper

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

/**
 * Push (FCM): el plugin de Google Services solo se aplica si existe app/google-services.json
 * (fuera de git). Debug puede compilar sin él; release exige la configuración de producción.
 */
if (file("google-services.json").exists()) apply(plugin = "com.google.gms.google-services")

val verifyReleaseFirebase = tasks.register("verifyReleaseFirebase") {
    group = "verification"
    description = "Require the production Firebase configuration before packaging a release."
    val configFile = layout.projectDirectory.file("google-services.json")
    doLast {
        val source = configFile.asFile
        check(source.isFile) { "Release push requires app/google-services.json from Firebase project tiecoms." }
        val config = try {
            JsonSlurper().parse(source) as? Map<*, *>
        } catch (_: Exception) {
            // JSON parser errors can quote API keys from the source; keep diagnostics generic.
            error("Invalid Firebase JSON. Download app/google-services.json again from project tiecoms.")
        }
        val project = config?.get("project_info") as? Map<*, *>
        check(project?.get("project_id") == "tiecoms") { "Release Firebase project must be tiecoms." }
        val client = (config?.get("client") as? List<*>)?.filterIsInstance<Map<*, *>>()?.firstOrNull {
            val info = it["client_info"] as? Map<*, *>
            (info?.get("android_client_info") as? Map<*, *>)?.get("package_name") == "com.chaggu.app"
        }
        check(client != null) { "Release Firebase config must include package com.chaggu.app." }
        val info = client["client_info"] as? Map<*, *>
        val keys = client["api_key"] as? List<*>
        check(!project?.get("project_number")?.toString().isNullOrBlank() &&
            !info?.get("mobilesdk_app_id")?.toString().isNullOrBlank() &&
            keys?.filterIsInstance<Map<*, *>>()?.any { !it["current_key"]?.toString().isNullOrBlank() } == true
        ) { "Release Firebase config is incomplete; download the original Android config from project tiecoms." }
    }
}

tasks.matching { it.name == "preReleaseBuild" }.configureEach { dependsOn(verifyReleaseFirebase) }

/**
 * Firma de subida (upload key) de Play. Nada de esto vive en el repo: se lee de
 * propiedades de Gradle (-P / ~/.gradle/gradle.properties) o del entorno.
 *   TIECOMS_UPLOAD_STORE          ruta al .jks
 *   TIECOMS_UPLOAD_ALIAS          alias (por defecto tiecoms-upload)
 *   TIECOMS_UPLOAD_PASSWORD       contraseña del almacén y de la clave, o bien
 *   TIECOMS_UPLOAD_PASSWORD_FILE  archivo que la contiene
 */
fun signingValue(name: String): String? =
    (project.findProperty(name) as String?)?.takeIf { it.isNotBlank() } ?: System.getenv(name)?.takeIf { it.isNotBlank() }

val uploadStore = signingValue("TIECOMS_UPLOAD_STORE")?.let { File(it) }?.takeIf { it.exists() }
val uploadPassword = signingValue("TIECOMS_UPLOAD_PASSWORD")
    ?: signingValue("TIECOMS_UPLOAD_PASSWORD_FILE")?.let { File(it) }?.takeIf { it.exists() }?.readText()?.trim()

android {
    namespace = "com.tiecoms.app"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.chaggu.app"
        minSdk = 26
        targetSdk = 36
        versionCode = 15
        versionName = "1.6.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField("String", "DEFAULT_API_URL", "\"https://app.chaggu.com\"")
        buildConfigField("String", "CONTRACT_VERSION", "\"2026-09-23\"")
    }

    signingConfigs {
        create("release") {
            if (uploadStore != null && uploadPassword != null) {
                storeFile = uploadStore
                storePassword = uploadPassword
                keyAlias = signingValue("TIECOMS_UPLOAD_ALIAS") ?: "tiecoms-upload"
                keyPassword = uploadPassword
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (uploadStore != null && uploadPassword != null) {
                signingConfig = signingConfigs.getByName("release")
            }
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
    packaging {
        resources.excludes += setOf("/META-INF/{AL2.0,LGPL2.1}", "META-INF/versions/9/previous-compilation-data.bin")
    }
    testOptions {
        unitTests.all {
            // Integración contra el API de pruebas: el fixture llega por entorno, nunca en el código.
            it.environment("TIECOMS_FIXTURE", System.getenv("TIECOMS_FIXTURE") ?: "")
            it.environment("TIECOMS_PEER_DIR", System.getenv("TIECOMS_PEER_DIR") ?: "")
            it.environment("TIECOMS_DELETE_API", System.getenv("TIECOMS_DELETE_API") ?: "")
            it.testLogging { events("passed", "skipped", "failed", "standardOut", "standardError"); showStandardStreams = true }
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.process)
    implementation(libs.androidx.work.runtime.ktx)
    // Direct Share en Android 8–9 (en 10+ lo resuelve el sistema con los atajos).
    implementation(libs.androidx.sharetarget)
    // Videos adjuntos: reproductor nativo con Bearer y Range (206) por OkHttp.
    implementation(libs.media3.exoplayer)
    implementation(libs.media3.ui)
    implementation(libs.media3.okhttp)
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.material3)
    implementation(libs.compose.material.icons.core)
    implementation(libs.compose.material.icons.extended)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.okhttp)
    implementation(libs.androidx.browser)
    implementation(libs.androidx.splashscreen)
    implementation(libs.firebase.messaging)
    debugImplementation(libs.compose.ui.tooling)
    debugImplementation(libs.compose.ui.test.manifest)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)

    androidTestImplementation(platform(libs.compose.bom))
    androidTestImplementation(libs.compose.ui.test.junit4)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.rules)
    androidTestImplementation(libs.androidx.test.core)
    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.androidx.test.uiautomator)
}
