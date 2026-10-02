package com.tiecoms.app.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import com.tiecoms.app.core.Fmt

/*
 * Formato básico en la burbuja (core/Fmt.kt). Se arma el AnnotatedString con las marcas puestas, así las posiciones
 * de menciones, @gg y resaltado de búsqueda siguen siendo las del texto original; al final [dropMarks] las quita
 * conservando estilos, enlaces y contenido en línea.
 */

internal fun fmtStyle(kind: Fmt.Kind, color: Color): SpanStyle = when (kind) {
    Fmt.Kind.BOLD -> SpanStyle(fontWeight = FontWeight.Bold)
    Fmt.Kind.ITALIC -> SpanStyle(fontStyle = FontStyle.Italic)
    Fmt.Kind.STRIKE -> SpanStyle(textDecoration = TextDecoration.LineThrough)
    Fmt.Kind.CODE -> SpanStyle(fontFamily = FontFamily.Monospace, background = color.copy(alpha = 0.12f))
}

/** Agrega [s] (texto plano, sin enlaces) con su formato; anota en [marks] dónde quedaron las marcas. */
internal fun AnnotatedString.Builder.appendFormatted(s: String, color: Color, marks: MutableList<Int>) {
    var at = 0
    Fmt.spans(s).forEach { sp ->
        append(s.substring(at, sp.start))
        repeat(sp.marks) { k -> marks += length; append(s[sp.start + k]) }
        withStyle(fmtStyle(sp.kind, color)) { append(s.substring(sp.start + sp.marks, sp.end - sp.marks)) }
        repeat(sp.marks) { k -> marks += length; append(s[sp.end - sp.marks + k]) }
        at = sp.end
    }
    append(s.substring(at))
}

/** Quita los caracteres en [marks] (posiciones de este texto) sin perder estilos ni enlaces. */
internal fun AnnotatedString.dropMarks(marks: List<Int>): AnnotatedString {
    if (marks.isEmpty()) return this
    val src = this
    return buildAnnotatedString {
        var at = 0
        marks.sorted().forEach { i -> if (i >= at) { append(src.subSequence(at, i)); at = i + 1 } }
        append(src.subSequence(at, src.length))
    }
}
