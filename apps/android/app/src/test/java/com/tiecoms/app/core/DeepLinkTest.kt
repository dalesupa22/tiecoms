package com.tiecoms.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DeepLinkTest {
    @Test fun `enlaces https de los tres hosts`() {
        assertEquals(DeepLink.Conversation("abc-1"), DeepLinks.parse("https://app.tiecoms.com/c/abc-1"))
        assertEquals(DeepLink.Workspace("w1"), DeepLinks.parse("https://tiecoms.com/w/w1/"))
        assertEquals(DeepLink.Invite("tok_XYZ"), DeepLinks.parse("https://www.tiecoms.com/invite/tok_XYZ"))
        assertEquals(DeepLink.Signup("orgtok"), DeepLinks.parse("https://app.tiecoms.com/signup?org=orgtok"))
        assertEquals(DeepLink.Signup(null), DeepLinks.parse("https://app.tiecoms.com/signup"))
    }

    @Test fun `esquema propio`() {
        assertEquals(DeepLink.Conversation("c1"), DeepLinks.parse("tiecoms://c/c1"))
        assertEquals(DeepLink.Conversation("c1"), DeepLinks.parse("tiecoms:///c/c1"))
        assertEquals(DeepLink.Invite("t"), DeepLinks.parse("tiecoms://invite/t"))
        assertEquals(DeepLink.Signup("o"), DeepLinks.parse("tiecoms://signup?org=o"))
    }

    @Test fun `hosts o rutas ajenas se rechazan`() {
        assertNull(DeepLinks.parse("https://evil.com/c/abc"))
        assertNull(DeepLinks.parse("https://app.tiecoms.com/otra/abc"))
        assertNull(DeepLinks.parse("https://app.tiecoms.com/c/"))
        assertNull(DeepLinks.parse("https://app.tiecoms.com/c/a%20b"))
        assertNull(DeepLinks.parse("javascript:alert(1)"))
        assertNull(DeepLinks.parse(null))
    }
}
