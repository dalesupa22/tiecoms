package com.tiecoms.baselineprofile

import androidx.benchmark.macro.junit4.BaselineProfileRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Recorrido crítico: arranque en frío → lista → abrir chats → volver → desplazar la lista. */
@RunWith(AndroidJUnit4::class)
class BaselineProfileGenerator {
    @get:Rule val rule = BaselineProfileRule()

    @Test fun generate() = rule.collect(packageName = PACKAGE, includeInStartupProfile = true) {
        pressHome()
        startActivityAndWait()
        ensureSignedIn()
        waitForList()
        scrollList()
        for (i in 0 until 3) { openChat(i); device.pressBack(); waitForList() }
    }
}
