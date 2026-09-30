package com.tiecoms.baselineprofile

import androidx.benchmark.macro.BaselineProfileMode
import androidx.benchmark.macro.CompilationMode
import androidx.benchmark.macro.FrameTimingMetric
import androidx.benchmark.macro.StartupMode
import androidx.benchmark.macro.junit4.MacrobenchmarkRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Fluidez (1.7.1): fotogramas al desplazar el chat (200 mensajes, algunos muy largos) y la lista de Grupos,
 * con el Baseline Profile. frameDurationCpuMs y frameOverrunMs (P50/P90/P95/P99) de FrameTimingMetric.
 * Datos: scripts/mobile-fixture.mjs + scripts/android-bench-fixture.mjs contra el API local.
 */
@RunWith(AndroidJUnit4::class)
class FluencyBenchmark {
    @get:Rule val rule = MacrobenchmarkRule()

    @Test fun scrollChat() = rule.measureRepeated(
        packageName = PACKAGE, metrics = listOf(FrameTimingMetric()), iterations = 5,
        startupMode = StartupMode.WARM, compilationMode = CompilationMode.Partial(BaselineProfileMode.Require),
        setupBlock = { pressHome(); startActivityAndWait(); ensureSignedIn(); waitForList(); openGroupChat() },
    ) { scrollChat() }

    @Test fun scrollGroupsList() = rule.measureRepeated(
        packageName = PACKAGE, metrics = listOf(FrameTimingMetric()), iterations = 5,
        startupMode = StartupMode.WARM, compilationMode = CompilationMode.Partial(BaselineProfileMode.Require),
        setupBlock = { pressHome(); startActivityAndWait(); ensureSignedIn(); waitForList() },
    ) { scrollGroups() }
}
