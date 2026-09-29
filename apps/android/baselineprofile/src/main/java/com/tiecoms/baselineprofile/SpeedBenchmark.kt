package com.tiecoms.baselineprofile

import androidx.benchmark.macro.BaselineProfileMode
import androidx.benchmark.macro.CompilationMode
import androidx.benchmark.macro.ExperimentalMetricApi
import androidx.benchmark.macro.StartupMode
import androidx.benchmark.macro.StartupTimingMetric
import androidx.benchmark.macro.TraceSectionMetric
import androidx.benchmark.macro.junit4.MacrobenchmarkRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Tiempos de la fase 2 de 1.7.0: arranque en frío hasta la lista (timeToFullDisplay = reportFullyDrawn con la
 * lista pintada) y tocar un chat hasta ver mensajes (sección tcOpenChat). Sin y con Baseline Profile.
 */
@OptIn(ExperimentalMetricApi::class)
@RunWith(AndroidJUnit4::class)
class SpeedBenchmark {
    @get:Rule val rule = MacrobenchmarkRule()

    private fun startup(mode: CompilationMode) = rule.measureRepeated(
        packageName = PACKAGE, metrics = listOf(StartupTimingMetric()), iterations = 10,
        startupMode = StartupMode.COLD, compilationMode = mode,
        setupBlock = { pressHome() },
    ) {
        startActivityAndWait()
        waitForList()
    }

    private fun openChat(mode: CompilationMode) = rule.measureRepeated(
        packageName = PACKAGE, metrics = listOf(TraceSectionMetric("tcOpenChat", TraceSectionMetric.Mode.First)), iterations = 10,
        startupMode = StartupMode.COLD, compilationMode = mode,
        setupBlock = { pressHome(); startActivityAndWait(); ensureSignedIn(); waitForList() },
    ) {
        openChat(0)
    }

    @Test fun startupNoProfile() = startup(CompilationMode.None())
    @Test fun startupBaselineProfile() = startup(CompilationMode.Partial(BaselineProfileMode.Require))
    @Test fun openChatNoProfile() = openChat(CompilationMode.None())
    @Test fun openChatBaselineProfile() = openChat(CompilationMode.Partial(BaselineProfileMode.Require))
}
