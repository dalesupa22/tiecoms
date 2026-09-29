pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "Chaggu"
include(":app")
// Velocidad (1.7.0): genera el Baseline Profile y mide el arranque (Macrobenchmark). No se publica.
include(":baselineprofile")
