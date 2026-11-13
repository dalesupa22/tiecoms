package com.tiecoms.app.ui

import com.tiecoms.app.R
import com.tiecoms.app.platform.PushSetup.Health
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PushHealthTest {
    @Test fun `notifications off wins over everything`() {
        assertEquals(PushHealth.Issue.OFF, PushHealth.issue(false, Health.FAILED, batteryExempt = false, batteryDismissed = false))
    }

    @Test fun `failed registration is shown before the battery hint`() {
        assertEquals(PushHealth.Issue.FAILED, PushHealth.issue(true, Health.FAILED, batteryExempt = false, batteryDismissed = false))
    }

    @Test fun `battery hint only while not exempt and not dismissed`() {
        assertEquals(PushHealth.Issue.BATTERY, PushHealth.issue(true, Health.OK, batteryExempt = false, batteryDismissed = false))
        assertNull(PushHealth.issue(true, Health.OK, batteryExempt = false, batteryDismissed = true))
        assertNull(PushHealth.issue(true, Health.UNKNOWN, batteryExempt = true, batteryDismissed = false))
    }

    @Test fun `brand steps cover the phones seen in production`() {
        assertEquals(R.string.ph_battery_transsion, PushHealth.brandSteps("TECNO"))
        assertEquals(R.string.ph_battery_transsion, PushHealth.brandSteps("Infinix"))
        assertEquals(R.string.ph_battery_xiaomi, PushHealth.brandSteps("Xiaomi"))
        assertEquals(R.string.ph_battery_oppo, PushHealth.brandSteps("OPPO"))
        assertEquals(R.string.ph_battery_huawei, PushHealth.brandSteps("HONOR"))
        assertEquals(R.string.ph_battery_samsung, PushHealth.brandSteps("samsung"))
        assertNull(PushHealth.brandSteps("Google"))
    }
}
