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
        // The thinking-orbs library alone; nothing else may resolve from JitPack.
        maven("https://jitpack.io") { content { includeGroup("com.github.yogesharc") } }
    }
}
rootProject.name = "Dray"
include(":app")
