package com.tiecoms.app.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Las marcas se ocultan sin perder menciones, enlaces ni el resaltado (posiciones del texto original). */
class FormattedTextTest {
    @Test fun `quita las marcas y conserva enlaces y estilos`() {
        val marks = mutableListOf<Int>()
        val out = buildAnnotatedString {
            appendFormatted("mira *esto* en ", Color.Black, marks)
            withLink(LinkAnnotation.Url("https://a.co")) { append("https://a.co") }
            append(" ")
            withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append("@Ana") }
            appendFormatted(" y `x_y`", Color.Black, marks)
        }.dropMarks(marks)
        assertEquals("mira esto en https://a.co @Ana y x_y", out.text)
        val link = out.getLinkAnnotations(0, out.length).single()
        assertEquals("https://a.co", out.text.substring(link.start, link.end))
        val bold = out.spanStyles.first { it.item.fontWeight == FontWeight.Bold }
        assertEquals("esto", out.text.substring(bold.start, bold.end))
        val mention = out.spanStyles.first { it.item.fontWeight == FontWeight.SemiBold }
        assertEquals("@Ana", out.text.substring(mention.start, mention.end))
        assertTrue(out.spanStyles.any { it.item.fontFamily != null && out.text.substring(it.start, it.end) == "x_y" })
    }
}
