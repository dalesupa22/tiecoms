package com.tiecoms.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Formato básico en los mensajes, como en la web (apps/web/test/formatted.test.tsx, 30-sep-2026). */
class FmtTest {
    /** Texto como se ve, con el formato marcado como en HTML para comparar fácil. */
    private fun html(text: String): String {
        val (shown, spans) = Fmt.render(text)
        val tag = mapOf(Fmt.Kind.BOLD to "strong", Fmt.Kind.ITALIC to "em", Fmt.Kind.STRIKE to "s", Fmt.Kind.CODE to "code")
        val sb = StringBuilder(); var at = 0
        spans.forEach { sp -> sb.append(shown, at, sp.start).append("<${tag[sp.kind]}>").append(shown, sp.start, sp.end).append("</${tag[sp.kind]}>"); at = sp.end }
        return sb.append(shown, at, shown.length).toString()
    }

    @Test fun `negrilla, cursiva, tachado y codigo`() {
        assertEquals("para el <strong>viernes</strong>", html("para el *viernes*"))
        assertEquals("la <em>plantilla</em> ya", html("la _plantilla_ ya"))
        assertEquals("<s>Llamar</s>", html("~Llamar~"))
        assertEquals("sube <code>a.xlsx</code>", html("sube `a.xlsx`"))
        assertEquals("<strong>a b</strong> y <em>c</em>", html("*a b* y _c_"))
        assertEquals("<strong>ok</strong>.", html("*ok*."))
    }

    @Test fun `no toca lo que no es formato`() {
        assertEquals("nombre_de_archivo.pdf", html("nombre_de_archivo.pdf"))
        assertEquals("2 * 3 * 4", html("2 * 3 * 4"))
        assertEquals("* suelto", html("* suelto"))
        assertEquals("* espacio *", html("* espacio *"))
        assertEquals("*dos\nlíneas*", html("*dos\nlíneas*"))
        assertEquals("a*b*c", html("a*b*c"))
        assertEquals("sin marcas", html("sin marcas"))
    }

    @Test fun `rangos sobre el texto original incluyen las marcas`() {
        assertEquals(listOf(Fmt.Span(4, 9, Fmt.Kind.BOLD)), Fmt.spans("hey *uno* dos"))
        assertTrue(Fmt.spans("").isEmpty())
    }

    @Test fun `vinetas al inicio de linea con la misma longitud`() {
        val raw = "Pendientes:\n- uno\n  * dos\n-sin espacio\na - b"
        val out = Fmt.bullets(raw)
        assertEquals("Pendientes:\n• uno\n  • dos\n-sin espacio\na - b", out)
        assertEquals(raw.length, out.length)
        assertEquals("• primera", Fmt.bullets("- primera"))
        assertEquals("- ", Fmt.bullets("- "))
    }
}
