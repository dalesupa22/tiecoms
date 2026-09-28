package com.tiecoms.app.core

import org.junit.Assert.assertEquals
import org.junit.Test

class TextSizeTest {
    @Test fun `cinco pasos y se multiplica por la escala del sistema`() {
        assertEquals(listOf(0.9f, 1.0f, 1.15f, 1.3f, 1.45f), TextSize.STEPS)
        assertEquals(1.3f * 1.15f, TextSize.fontScale(1.3f, 1.15f), 1e-6f)
        assertEquals(0.9f, TextSize.fontScale(1f, 0.9f), 1e-6f)
    }
    @Test fun `valores guardados raros vuelven a Normal`() {
        assertEquals(1f, TextSize.sanitize(3f), 0f)
        assertEquals(1.45f, TextSize.sanitize(1.45f), 0f)
        assertEquals(4, TextSize.index(1.45f)); assertEquals(1, TextSize.index(1f)); assertEquals(2, TextSize.index(1.2f))
    }
}
